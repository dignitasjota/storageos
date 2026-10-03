import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { addAmounts, isAtLeast, isGreaterThan, subtractAmounts, toCents } from '../../common/money';
import { assertNotInSepaRemittance } from '../../common/sepa-remittance-guard';
import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type InvoiceRefundedPayload,
  type PaymentOverpaidPayload,
  type PaymentFailedPayload,
} from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';

import { GoCardlessChargeService } from './gocardless/gocardless-charge.service';
import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import { PaymentMethodsService } from './payment-methods.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Payment, PaymentStatus, Prisma } from '@storageos/database';
import type {
  BulkInvoiceActionResultDto,
  ChargeInvoiceInput,
  PaymentDto,
  PaymentStatusValue,
} from '@storageos/shared';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly paymentMethods: PaymentMethodsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly goCardlessCharge: GoCardlessChargeService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    tenantId: string,
    filters: { invoiceId?: string; customerId?: string; facilityScope?: string[] | null },
  ): Promise<PaymentDto[]> {
    const where: Prisma.PaymentWhereInput = {};
    if (filters.invoiceId) where.invoiceId = filters.invoiceId;
    if (filters.customerId) where.customerId = filters.customerId;
    // Alcance por local: solo los pagos de facturas de contratos de sus locales.
    // Los pagos de facturas sin contrato (sin local) se incluyen.
    if (filters.facilityScope) {
      where.invoice = {
        OR: [
          { contract: { unit: { facilityId: { in: filters.facilityScope } } } },
          { contractId: null },
        ],
      };
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          include: {
            invoice: { select: { invoiceNumber: true } },
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async chargeInvoice(args: {
    tenantId: string;
    /** `null` cuando el cobro lo lanza el inquilino desde el portal. */
    userId: string | null;
    invoiceId: string;
    input: ChargeInvoiceInput;
    /** Locales a los que el usuario está restringido; null/undefined = todos. */
    facilityScope?: string[] | null;
    /**
     * Cobro en segundo plano (auto-charge, reintentos): si se rechaza se avisa
     * al inquilino por email. En el portal o desde el panel ya ve el resultado.
     */
    notifyCustomerOnFailure?: boolean;
    meta: RequestMeta;
  }): Promise<PaymentDto> {
    const invoice = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: args.invoiceId, deletedAt: null },
          include: {
            customer: { select: { id: true } },
            contract: { select: { unit: { select: { facilityId: true } } } },
          },
        }),
      args.tenantId,
    );
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    // Alcance por local: no se puede cobrar una factura de un contrato de un
    // local fuera del scope del usuario. Las facturas sin contrato (F2/ventas)
    // no están ancladas a un local → permitidas.
    const facilityId = invoice.contract?.unit?.facilityId;
    if (facilityId) assertFacilityAllowed(args.facilityScope, facilityId);
    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      throw new BadRequestException({
        code: 'invoice_not_payable',
        message: 'La factura no es cobrable en este estado',
      });
    }
    // Un cobro SEPA/GoCardless queda `processing` varios días sin marcar la
    // factura como pagada: sin este guard, el inquilino (o el auto-charge)
    // podría lanzar un SEGUNDO adeudo sobre la misma factura → doble cobro.
    await this.assertNoPaymentInFlight(args.tenantId, invoice.id);
    // F2 sin destinatario no tiene customer ni metodo de pago: el cobro
    // automatico via gateway no es posible. El cobro en metalico se
    // registra via `mark-paid`.
    if (!invoice.customerId) {
      throw new BadRequestException({
        code: 'invoice_without_customer',
        message: 'La factura no tiene cliente; no se puede cobrar via gateway',
      });
    }
    const invoiceCustomerId: string = invoice.customerId;
    const pending = subtractAmounts(invoice.total, invoice.amountPaid);
    const amount = args.input.amount ?? pending;
    if (amount <= 0 || isGreaterThan(amount, pending)) {
      throw new BadRequestException({
        code: 'invalid_amount',
        message: 'Importe invalido',
      });
    }
    // Justificantes de fianza que se cobran en el MISMO pago que esta factura
    // (reserva online): un solo cargo, repartido entre los documentos. Solo al
    // cobrar el total pendiente.
    const bundled =
      args.input.amount === undefined
        ? (
            await this.prisma.withTenant(
              (tx) =>
                tx.invoice.findMany({
                  where: {
                    bundledWithInvoiceId: invoice.id,
                    kind: 'deposit_receipt',
                    status: { in: ['issued', 'overdue'] },
                    deletedAt: null,
                  },
                  select: { id: true, total: true, amountPaid: true },
                }),
              args.tenantId,
            )
          )
            .map((r) => ({ id: r.id, amount: subtractAmounts(r.total, r.amountPaid) }))
            .filter((r) => r.amount > 0)
        : [];
    for (const r of bundled) await this.assertNoPaymentInFlight(args.tenantId, r.id);
    const chargeAmount = bundled.reduce((sum, r) => addAmounts(sum, r.amount), amount);

    // Resolver payment method.
    const pmId =
      args.input.paymentMethodId ??
      (
        await this.prisma.withTenant(
          (tx) =>
            tx.paymentMethod.findFirst({
              where: { customerId: invoiceCustomerId, isDefault: true, deletedAt: null },
            }),
          args.tenantId,
        )
      )?.id;
    if (!pmId) {
      throw new BadRequestException({
        code: 'no_payment_method',
        message: 'No hay metodo de pago disponible para el inquilino',
      });
    }

    // === FASE 1 (reserva, tx corta) ===
    // Reserva ATÓMICA del slot de cobro ANTES de llamar al gateway: crea el
    // `payment` en estado `processing` (que cuenta en el índice único parcial
    // `payments_one_live_gateway_charge`). Con esto el cargo externo ocurre
    // FUERA de la transacción → si el commit fallara tras cobrar ya NO habría
    // cargo huérfano (siempre queda el registro reservado, que el webhook
    // reconcilia). El advisory lock serializa el doble clic; el 2º ve la reserva
    // del 1º → 409 SIN llamar al gateway (evita el doble CARGO real).
    const reserved = await this.prisma.withTenant(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${invoice.id}::text))`;
      const liveGatewayCharge = await tx.payment.count({
        where: {
          invoiceId: invoice.id,
          gateway: { in: ['stripe', 'gocardless'] },
          status: { in: ['pending', 'processing', 'succeeded'] },
        },
      });
      if (liveGatewayCharge > 0) {
        throw new ConflictException({
          code: 'payment_in_progress',
          message: 'Ya hay un cobro por pasarela para esta factura. Espera a que se confirme.',
        });
      }
      const pm = await tx.paymentMethod.findUniqueOrThrow({ where: { id: pmId } });
      // Solo card y sepa_debit son cobrables via gateway; bank_transfer,
      // cash y other se registran a mano con mark-paid.
      if (pm.type !== 'card' && pm.type !== 'sepa_debit') {
        throw new BadRequestException({
          code: 'payment_method_not_chargeable',
          message: 'El metodo de pago no admite cobro automatico',
        });
      }
      const tokenPlain = await this.paymentMethods.decryptToken(tx, pm.id);
      const bundledPaymentIds: { invoiceId: string; paymentId: string; amount: number }[] = [];
      for (const r of bundled) {
        const live = await tx.payment.count({
          where: {
            invoiceId: r.id,
            gateway: { in: ['stripe', 'gocardless'] },
            status: { in: ['pending', 'processing', 'succeeded'] },
          },
        });
        if (live > 0) {
          throw new ConflictException({
            code: 'payment_in_progress',
            message: 'Ya hay un cobro en curso para la fianza. Espera a que se confirme.',
          });
        }
        const row = await tx.payment.create({
          data: {
            tenantId: args.tenantId,
            invoiceId: r.id,
            customerId: invoiceCustomerId,
            paymentMethodId: pm.id,
            amount: r.amount,
            currency: invoice.currency,
            status: 'processing',
            methodType: pm.type,
            gateway: pm.gateway,
          },
          select: { id: true },
        });
        bundledPaymentIds.push({ invoiceId: r.id, paymentId: row.id, amount: r.amount });
      }
      const created = await tx.payment.create({
        data: {
          tenantId: args.tenantId,
          invoiceId: invoice.id,
          customerId: invoiceCustomerId,
          paymentMethodId: pm.id,
          amount,
          currency: invoice.currency,
          status: 'processing',
          methodType: pm.type,
          gateway: pm.gateway,
        },
        select: { id: true },
      });
      return {
        paymentId: created.id,
        bundledPayments: bundledPaymentIds,
        gateway: pm.gateway,
        type: pm.type,
        gatewayCustomerId: pm.gatewayCustomerId,
        tokenPlain,
      };
    }, args.tenantId);

    // === FASE 2 (cargo externo, FUERA de tx) ===
    // Multi-gateway: GoCardless cobra contra el mandato (queda `processing`
    // hasta el webhook); el resto va por el gateway por defecto (Stripe). Un
    // fallo del gateway marca la reserva como `failed` (libera el slot) y relanza.
    let chargeResult: Awaited<ReturnType<typeof this.gateway.charge>>;
    try {
      chargeResult =
        reserved.gateway === 'gocardless'
          ? await this.goCardlessCharge.charge({
              tenantId: args.tenantId,
              mandateId: reserved.tokenPlain,
              amountCents: toCents(chargeAmount),
              currency: invoice.currency,
              description: `Factura ${invoice.invoiceNumber}`,
              metadata: {
                invoiceId: invoice.id,
                tenantId: args.tenantId,
                paymentId: reserved.paymentId,
              },
            })
          : await this.gateway.charge({
              gatewayCustomerId: reserved.gatewayCustomerId ?? '',
              paymentMethodToken: reserved.tokenPlain,
              paymentMethodType: reserved.type,
              amountCents: toCents(chargeAmount),
              currency: invoice.currency,
              description: `Factura ${invoice.invoiceNumber}`,
              metadata: {
                invoiceId: invoice.id,
                tenantId: args.tenantId,
                paymentId: reserved.paymentId,
              },
              offSession: true,
            });
    } catch (err) {
      await this.prisma.withTenant(
        (tx) =>
          tx.payment.updateMany({
            where: {
              id: { in: [reserved.paymentId, ...reserved.bundledPayments.map((b) => b.paymentId)] },
            },
            data: {
              status: 'failed',
              failureReason: err instanceof Error ? err.message.slice(0, 500) : 'gateway_error',
            },
          }),
        args.tenantId,
      );
      throw err;
    }

    // === FASE 3 (finalización, tx corta) ===
    // Actualiza la reserva con el resultado real + sincroniza la factura si
    // succeeded (el estado final también llega por el webhook).
    const status: PaymentStatus =
      chargeResult.status === 'succeeded'
        ? 'succeeded'
        : chargeResult.status === 'processing'
          ? 'processing'
          : chargeResult.status === 'requires_action'
            ? 'pending'
            : 'failed';
    let invoiceFullyPaid = false;
    const bundledPaidNow: string[] = [];
    const paymentRow = await this.prisma.withTenant(async (tx) => {
      // Solo esta llamada pasa la reserva de `processing` a su estado final: si
      // el webhook ya la resolvió (también puede llegar antes), no se vuelve a
      // sumar el cobro a la factura.
      const moved = await tx.payment.updateMany({
        where: { id: reserved.paymentId, status: 'processing' },
        data: {
          status,
          gatewayPaymentId: chargeResult.gatewayPaymentId,
          ...(chargeResult.status === 'succeeded' ? { paidAt: new Date() } : {}),
          ...(chargeResult.failureReason ? { failureReason: chargeResult.failureReason } : {}),
        },
      });
      const updated = await tx.payment.findUniqueOrThrow({
        where: { id: reserved.paymentId },
        include: {
          invoice: { select: { invoiceNumber: true } },
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
        },
      });
      // Los justificantes cobrados en el mismo cargo: misma suerte que la factura.
      for (const b of reserved.bundledPayments) {
        const bMoved = await tx.payment.updateMany({
          where: { id: b.paymentId, status: 'processing' },
          data: {
            status,
            gatewayPaymentId: chargeResult.gatewayPaymentId,
            ...(chargeResult.status === 'succeeded' ? { paidAt: new Date() } : {}),
            ...(chargeResult.failureReason ? { failureReason: chargeResult.failureReason } : {}),
          },
        });
        if (status === 'succeeded' && bMoved.count === 1) {
          const after = await tx.invoice.update({
            where: { id: b.invoiceId },
            data: { amountPaid: { increment: b.amount } },
            select: { amountPaid: true, total: true },
          });
          if (isAtLeast(Number(after.amountPaid), Number(after.total))) {
            const flipped = await tx.invoice.updateMany({
              where: { id: b.invoiceId, status: { in: ['issued', 'overdue'] } },
              data: { status: 'paid', paidAt: new Date() },
            });
            if (flipped.count > 0) bundledPaidNow.push(b.invoiceId);
          }
        }
      }
      if (status === 'succeeded' && moved.count === 1) {
        // Incremento atómico (no «pagado leído al principio + importe»): un cobro
        // manual o un webhook simultáneos sobre la misma factura no se pisan.
        const after = await tx.invoice.update({
          where: { id: invoice.id },
          data: { amountPaid: { increment: amount } },
          select: { amountPaid: true, total: true },
        });
        if (isAtLeast(Number(after.amountPaid), Number(after.total))) {
          const flipped = await tx.invoice.updateMany({
            where: { id: invoice.id, status: { in: ['issued', 'overdue'] } },
            data: { status: 'paid', paidAt: new Date() },
          });
          invoiceFullyPaid = flipped.count > 0;
        }
      }
      return updated;
    }, args.tenantId);
    // Un solo aviso por el cobro conjunto (el de la factura): los avisos del
    // justificante cobrado en el mismo cargo se omiten para no emitir el acceso
    // dos veces a la vez.
    if (bundledPaidNow.length > 0) {
      this.logger.debug(
        `[payments] fianzas cobradas con ${invoice.id}: ${bundledPaidNow.join(', ')}`,
      );
    }
    if (invoiceFullyPaid) await this.emitInvoicePaid(args.tenantId, invoice.id);
    if (chargeResult.status === 'failed' && args.notifyCustomerOnFailure) {
      this.emitPaymentFailed({
        tenantId: args.tenantId,
        invoiceId: invoice.id,
        customerId: invoiceCustomerId,
        amount,
        reason: chargeResult.failureReason ?? null,
      });
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: chargeResult.status === 'succeeded' ? 'payment.succeeded' : 'payment.attempted',
      entityType: 'Payment',
      entityId: paymentRow.id,
      changes: {
        invoiceId: invoice.id,
        amount,
        result: chargeResult.status,
        ...(chargeResult.failureReason ? { failureReason: chargeResult.failureReason } : {}),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(paymentRow);
  }

  /**
   * Cobra N facturas en lote con el método de pago por defecto de cada cliente.
   * Procesa cada una independientemente: un fallo (sin método, ya pagada, gateway
   * rechaza…) no tumba el resto; se reporta en `failed`. Un cobro SEPA que queda
   * `processing` cuenta como iniciado con éxito.
   */
  async bulkCharge(args: {
    tenantId: string;
    userId: string;
    ids: string[];
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<BulkInvoiceActionResultDto> {
    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const invoiceId of args.ids) {
      try {
        await this.chargeInvoice({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId,
          input: {},
          facilityScope: args.facilityScope ?? null,
          meta: args.meta,
        });
        succeeded.push(invoiceId);
      } catch (err) {
        let code = 'unknown_error';
        if (err && typeof err === 'object' && 'response' in err) {
          const res = (err as { response?: unknown }).response;
          if (res && typeof res === 'object' && 'code' in res) {
            code = String((res as { code: unknown }).code);
          }
        } else if (err instanceof Error) {
          code = err.message;
        }
        failed.push({ id: invoiceId, error: code });
      }
    }
    return { succeeded, failed };
  }

  /**
   * Comprueba que el inquilino tiene un método de pago por defecto COBRABLE
   * (tarjeta o adeudo SEPA/GoCardless) antes de entregar algo que se cobra en
   * el acto (tienda, pase nocturno). Lanza 400 `no_payment_method` si no hay
   * ninguno o el predeterminado no es cobrable (efectivo/transferencia). Se
   * llama ANTES de crear la venta/pase para no dejar factura ni producto
   * colgando cuando el cobro no es posible.
   */
  async assertChargeableDefaultMethod(tenantId: string, customerId: string): Promise<void> {
    const pm = await this.prisma.withTenant(
      (tx) =>
        tx.paymentMethod.findFirst({
          where: { customerId, isDefault: true, deletedAt: null },
        }),
      tenantId,
    );
    if (!pm || (pm.type !== 'card' && pm.type !== 'sepa_debit')) {
      throw new BadRequestException({
        code: 'no_payment_method',
        message:
          'No tienes un método de pago para cobrar en el acto. Añade una tarjeta o domiciliación para continuar.',
      });
    }
  }

  /**
   * Lanza 409 `payment_in_progress` si ya hay un cobro en vuelo (`processing` /
   * `pending`) sobre la factura. Un adeudo SEPA/GoCardless tarda días en
   * confirmarse y no marca la factura como pagada mientras tanto, así que sin
   * esto un segundo intento generaría un doble cobro.
   */
  async assertNoPaymentInFlight(tenantId: string, invoiceId: string): Promise<void> {
    const inFlight = await this.prisma.withTenant(async (tx) => {
      // En una remesa SEPA sin confirmar: el banco la cobrará (409 propio).
      await assertNotInSepaRemittance(tx, invoiceId);
      return tx.payment.count({
        where: { invoiceId, status: { in: ['processing', 'pending'] } },
      });
    }, tenantId);
    if (inFlight > 0) {
      throw new ConflictException({
        code: 'payment_in_progress',
        message: 'Ya hay un pago en curso para esta factura. Espera a que se confirme.',
      });
    }
  }

  /**
   * Sincroniza un payment con el estado real del gateway (llamado desde
   * el webhook handler).
   *
   * Idempotencia: Stripe reintenta webhooks (duplicados garantizados) y puede
   * entregarlos desordenados; ademas `chargeInvoice` ya deja el payment en
   * `succeeded` y suma a `invoice.amountPaid` cuando el cargo off-session se
   * confirma en sincrono. Solo la PRIMERA transicion a `succeeded` debe sumar
   * al `amountPaid`; un evento repetido o uno que llegue tras un estado
   * terminal (succeeded/refunded) es no-op.
   */
  async syncFromWebhook(args: {
    tenantId: string;
    gatewayPaymentId: string;
    newStatus: PaymentStatusValue;
    paidAt?: Date;
    failureReason?: string;
  }): Promise<void> {
    // Un cargo puede cubrir varios documentos (factura + justificante de
    // fianza cobrados juntos): todos sus pagos comparten el id de la pasarela.
    const group = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where: { gatewayPaymentId: args.gatewayPaymentId },
          include: { invoice: { select: { kind: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      args.tenantId,
    );
    if (group.length === 0) {
      this.logger.warn(
        `Webhook recibido para payment desconocido ${args.gatewayPaymentId} (tenant ${args.tenantId})`,
      );
      return;
    }
    const isGroup = group.length > 1;
    for (const existing of group) {
      // En un cobro conjunto solo avisa la factura (no el justificante).
      const silent = isGroup && existing.invoice?.kind === 'deposit_receipt';
      await this.syncOneFromWebhook(args, existing, silent);
    }
  }

  private async syncOneFromWebhook(
    args: {
      tenantId: string;
      gatewayPaymentId: string;
      newStatus: PaymentStatusValue;
      paidAt?: Date;
      failureReason?: string;
    },
    existing: {
      id: string;
      status: PaymentStatus;
      invoiceId: string | null;
      customerId: string | null;
      amount: Prisma.Decimal;
    },
    silent: boolean,
  ): Promise<void> {
    const terminalStatuses: PaymentStatus[] = ['succeeded', 'refunded', 'partially_refunded'];
    let invoicePaidNow = false;
    let transitioned = false;
    let excessCents = 0;
    await this.prisma.withTenant(async (tx) => {
      // Transición ATÓMICA: solo cambia si el pago no está ya en ese estado ni en
      // uno terminal. Dos webhooks distintos que llegan a la vez para el mismo
      // cobro (`confirmed` + `paid_out` de GoCardless, reintentos de Stripe con
      // otro id de evento…) ya no suman dos veces el cobro a la factura.
      const moved = await tx.payment.updateMany({
        where: {
          id: existing.id,
          status: { notIn: [...terminalStatuses, args.newStatus as PaymentStatus] },
        },
        data: {
          status: args.newStatus as PaymentStatus,
          ...(args.paidAt ? { paidAt: args.paidAt } : {}),
          ...(args.failureReason ? { failureReason: args.failureReason } : {}),
        },
      });
      if (moved.count === 0) return;
      transitioned = true;
      if (args.newStatus === 'succeeded' && existing.invoiceId) {
        // amountPaid ATÓMICO: `increment` en vez de leer-calcular-escribir, para
        // que dos webhooks concurrentes de la misma factura no se pisen (lost
        // update). El nuevo total lo devuelve el propio update → decide el status.
        const updated = await tx.invoice.update({
          where: { id: existing.invoiceId },
          data: { amountPaid: { increment: existing.amount } },
          select: { amountPaid: true, total: true },
        });
        // Factura ya pagada por otra vía (transferencia, efectivo…) mientras el
        // cobro estaba en curso: lo cobrado de más hay que devolverlo.
        excessCents = Math.min(
          toCents(existing.amount),
          Math.max(0, toCents(updated.amountPaid) - toCents(updated.total)),
        );
        if (isAtLeast(Number(updated.amountPaid), Number(updated.total))) {
          // Solo la transición a `paid` avisa (un segundo pago sobre una
          // factura ya pagada no vuelve a emitir el evento).
          const flipped = await tx.invoice.updateMany({
            where: { id: existing.invoiceId, status: { in: ['issued', 'overdue'] } },
            data: { status: 'paid', paidAt: args.paidAt ?? new Date() },
          });
          invoicePaidNow = flipped.count > 0;
        }
      }
    }, args.tenantId);
    if (!transitioned) {
      this.logger.log(
        `Webhook ignorado para payment ${existing.id}: status ${existing.status} -> ${args.newStatus} (duplicado o estado terminal)`,
      );
      return;
    }
    if (invoicePaidNow && existing.invoiceId && !silent) {
      await this.emitInvoicePaid(args.tenantId, existing.invoiceId);
    }
    if (excessCents > 0 && existing.invoiceId) {
      this.logger.warn(
        `Cobro ${args.gatewayPaymentId} confirmado sobre la factura ${existing.invoiceId} ya pagada: ${excessCents / 100} € de más`,
      );
      this.events.emit(DOMAIN_EVENTS.payment_overpaid, {
        tenantId: args.tenantId,
        invoiceId: existing.invoiceId,
        excess: excessCents / 100,
        gatewayPaymentId: args.gatewayPaymentId,
      } satisfies PaymentOverpaidPayload);
    }
    // Un adeudo o cobro que se resuelve rechazado después (SEPA, 3DS…): el
    // inquilino no estaba delante, así que se le avisa.
    if (args.newStatus === 'failed' && existing.invoiceId && !silent) {
      this.emitPaymentFailed({
        tenantId: args.tenantId,
        invoiceId: existing.invoiceId,
        customerId: existing.customerId,
        amount: Number(existing.amount),
        reason: args.failureReason ?? null,
      });
    }
  }

  private emitPaymentFailed(p: PaymentFailedPayload): void {
    this.events.emit(DOMAIN_EVENTS.payment_failed, {
      ...p,
      reason: friendlyFailureReason(p.reason),
    } satisfies PaymentFailedPayload);
  }

  /**
   * Evento `invoice_paid` para los cobros por pasarela (Stripe, GoCardless),
   * igual que lo emite el cobro manual: reactiva el acceso cortado por impago,
   * emite el PIN del primer pago, cierra expedientes de impago, push al
   * inquilino, notificación al staff, webhooks salientes y automatizaciones.
   * Best-effort: nunca rompe el cobro.
   */
  private async emitInvoicePaid(tenantId: string, invoiceId: string): Promise<void> {
    try {
      const inv = await this.prisma.withTenant(
        (tx) =>
          tx.invoice.findFirst({
            where: { id: invoiceId },
            select: {
              invoiceNumber: true,
              total: true,
              paidAt: true,
              customerId: true,
              customer: { select: { email: true } },
            },
          }),
        tenantId,
      );
      if (!inv) return;
      const payload: DomainEventPayload = {
        tenantId,
        entityType: 'invoice',
        entityId: invoiceId,
        customerId: inv.customerId,
        recipientEmail: inv.customer?.email ?? null,
        scope: {
          invoice: {
            number: inv.invoiceNumber,
            total: Number(inv.total).toFixed(2),
            paidAt: (inv.paidAt ?? new Date()).toISOString(),
          },
        },
      };
      this.events.emit(DOMAIN_EVENTS.invoice_paid, payload);
    } catch (err) {
      this.logger.warn(
        `invoice_paid no emitido para ${invoiceId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Sincroniza un refund hecho en el gateway (p.ej. desde el dashboard de
   * Stripe) a partir del webhook `charge.refunded`. Stripe manda
   * `amount_refunded` ACUMULADO, asi que la sincronizacion es por delta
   * contra `payment.refundedAmount`: un webhook repetido o atrasado
   * (delta <= 0) es no-op, lo que la hace idempotente por construccion.
   * Propaga el delta a la invoice asociada con los mismos estados que el
   * refund manual (`InvoicesService.refund`), capando en `total`.
   */
  async syncRefundFromWebhook(args: {
    tenantId: string;
    gatewayPaymentId: string;
    /** Acumulado reembolsado segun el gateway, en unidades de moneda (EUR). */
    amountRefunded: number;
  }): Promise<void> {
    // Cargo conjunto (factura + fianza): el acumulado devuelto se reparte en
    // orden, primero la factura y después el justificante.
    const group = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where: { gatewayPaymentId: args.gatewayPaymentId },
          include: { invoice: { select: { kind: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      args.tenantId,
    );
    if (group.length === 0) {
      this.logger.warn(
        `charge.refunded para payment desconocido ${args.gatewayPaymentId} (tenant ${args.tenantId})`,
      );
      return;
    }
    group.sort(
      (a, b) =>
        Number(a.invoice?.kind === 'deposit_receipt') -
        Number(b.invoice?.kind === 'deposit_receipt'),
    );
    let remainingCents = toCents(args.amountRefunded);
    for (const p of group) {
      const allocCents = Math.min(remainingCents, toCents(p.amount));
      remainingCents -= allocCents;
      await this.syncOneRefund(args.tenantId, p, allocCents / 100);
    }
  }

  private async syncOneRefund(
    tenantId: string,
    existing: { id: string; invoiceId: string | null },
    amountRefunded: number,
  ): Promise<void> {
    const args = { tenantId, amountRefunded };
    let delta = 0;
    await this.prisma.withTenant(async (tx) => {
      // Pago bloqueado + lectura fresca: dos `charge.refunded` seguidos (o el
      // reembolso hecho desde la app a la vez) no calculan el delta sobre la
      // misma lectura vieja → el reembolso no se suma dos veces a la factura.
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${existing.id}::uuid FOR UPDATE`;
      const fresh = await tx.payment.findUniqueOrThrow({
        where: { id: existing.id },
        select: { refundedAmount: true, amount: true },
      });
      delta = subtractAmounts(args.amountRefunded, fresh.refundedAmount);
      if (delta <= 0) return;
      const fullyRefunded = isAtLeast(args.amountRefunded, fresh.amount);
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          refundedAmount: args.amountRefunded,
          refundedAt: new Date(),
          status: fullyRefunded ? 'refunded' : 'partially_refunded',
        },
      });
      if (existing.invoiceId) {
        await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${existing.invoiceId}::uuid FOR UPDATE`;
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: existing.invoiceId },
        });
        const total = Number(invoice.total);
        const newInvoiceRefunded = Math.min(addAmounts(invoice.amountRefunded, delta), total);
        const invoiceFully = isAtLeast(newInvoiceRefunded, total);
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            amountRefunded: newInvoiceRefunded,
            status: invoiceFully ? 'refunded' : 'partially_refunded',
          },
        });
      }
    }, args.tenantId);
    if (delta <= 0) {
      this.logger.log(
        `charge.refunded ignorado para payment ${existing.id}: acumulado ${args.amountRefunded} ya registrado`,
      );
      return;
    }
    this.logger.log(
      `charge.refunded sincronizado: payment ${existing.id} refundedAmount=${args.amountRefunded} (delta ${delta.toFixed(2)})`,
    );
    // Devolución hecha desde la pasarela → abono por lo devuelto (el listener
    // ignora los justificantes de fianza).
    if (existing.invoiceId) {
      this.events.emit(DOMAIN_EVENTS.invoice_refunded, {
        tenantId,
        invoiceId: existing.invoiceId,
        amount: delta,
      } satisfies InvoiceRefundedPayload);
    }
  }

  /**
   * Sincroniza una disputa del gateway (webhook `charge.dispute.created`).
   * Para SEPA esto es la via por la que llegan las devoluciones bancarias
   * post-liquidacion (R-transactions): el banco del cliente revierte un
   * cargo que ya estaba `succeeded`, hasta 8 semanas despues.
   *
   * Idempotente: solo actua sobre payments en `succeeded`; un dispute
   * duplicado (el primero ya dejo el payment en `failed`) es no-op, asi
   * que nunca se resta dos veces de la invoice.
   */
  async syncDisputeFromWebhook(args: {
    tenantId: string;
    gatewayPaymentId: string;
    reason?: string;
  }): Promise<void> {
    // La disputa es del cargo entero: revierte todos sus documentos.
    const group = await this.prisma.withTenant(
      (tx) => tx.payment.findMany({ where: { gatewayPaymentId: args.gatewayPaymentId } }),
      args.tenantId,
    );
    if (group.length === 0) {
      this.logger.warn(
        `charge.dispute para payment desconocido ${args.gatewayPaymentId} (tenant ${args.tenantId})`,
      );
      return;
    }
    for (const existing of group) await this.syncOneDispute(args, existing);
  }

  private async syncOneDispute(
    args: { tenantId: string; gatewayPaymentId: string; reason?: string },
    existing: { id: string; invoiceId: string | null; amount: Prisma.Decimal },
  ): Promise<void> {
    let reverted = false;
    await this.prisma.withTenant(async (tx) => {
      // Solo el primero que pasa el pago de `succeeded` a `failed` resta el
      // importe: una disputa y un `charged_back` simultáneos no restan dos veces.
      const moved = await tx.payment.updateMany({
        where: { id: existing.id, status: 'succeeded' },
        data: {
          status: 'failed',
          failureReason: `disputed: ${args.reason ?? 'unknown'}`,
        },
      });
      if (moved.count === 0) return;
      reverted = true;
      if (existing.invoiceId) {
        await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${existing.invoiceId}::uuid FOR UPDATE`;
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: existing.invoiceId },
        });
        const newPaid = Math.max(0, subtractAmounts(invoice.amountPaid, existing.amount));
        // Si la factura estaba cobrada del todo, vuelve a estar pendiente:
        // overdue si ya vencio (lo normal, el dispute llega semanas despues),
        // issued si por lo que sea aun no.
        const revertedStatus =
          invoice.status === 'paid'
            ? invoice.dueDate && invoice.dueDate.getTime() < Date.now()
              ? 'overdue'
              : 'issued'
            : invoice.status;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            amountPaid: newPaid,
            status: revertedStatus,
            ...(invoice.status === 'paid' ? { paidAt: null } : {}),
          },
        });
      }
    }, args.tenantId);
    if (!reverted) {
      this.logger.log(
        `charge.dispute ignorado para payment ${existing.id}: no estaba cobrado (solo se revierte succeeded)`,
      );
      return;
    }
    this.logger.warn(
      `charge.dispute sincronizado: payment ${existing.id} revertido (${Number(existing.amount)} EUR, reason=${args.reason ?? 'unknown'})`,
    );
  }

  private toDto(
    row: Payment & {
      invoice?: { invoiceNumber: string } | null;
      customer?: {
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        customerType: 'individual' | 'business';
      } | null;
    },
  ): PaymentDto {
    const customerName = row.customer
      ? row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre'
      : row.customerId
        ? 'Inquilino'
        : 'Sin cliente (F2)';
    return {
      id: row.id,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoice?.invoiceNumber ?? null,
      customerId: row.customerId,
      customerName,
      paymentMethodId: row.paymentMethodId,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status as PaymentStatusValue,
      methodType: row.methodType,
      gateway: row.gateway,
      gatewayPaymentId: row.gatewayPaymentId,
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      refundedAt: row.refundedAt ? row.refundedAt.toISOString() : null,
      refundedAmount: Number(row.refundedAmount),
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Motivo de rechazo legible para el inquilino (códigos de Stripe/GoCardless). */
function friendlyFailureReason(code: string | null): string | null {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c.includes('insufficient')) return 'fondos insuficientes';
  if (c.includes('expired')) return 'tarjeta caducada';
  if (c.includes('declined') || c.includes('refused')) return 'pago rechazado por el banco';
  if (c.includes('mandate') || c.includes('cancelled')) return 'la domiciliación no está activa';
  return null;
}
