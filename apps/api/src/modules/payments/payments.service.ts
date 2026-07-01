import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { addAmounts, isAtLeast, isGreaterThan, subtractAmounts, toCents } from '../../common/money';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { GoCardlessChargeService } from './gocardless/gocardless-charge.service';
import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import { PaymentMethodsService } from './payment-methods.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Payment, PaymentStatus, Prisma } from '@storageos/database';
import type { ChargeInvoiceInput, PaymentDto, PaymentStatusValue } from '@storageos/shared';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly paymentMethods: PaymentMethodsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly goCardlessCharge: GoCardlessChargeService,
  ) {}

  async list(
    tenantId: string,
    filters: { invoiceId?: string; customerId?: string },
  ): Promise<PaymentDto[]> {
    const where: Prisma.PaymentWhereInput = {};
    if (filters.invoiceId) where.invoiceId = filters.invoiceId;
    if (filters.customerId) where.customerId = filters.customerId;
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
    meta: RequestMeta;
  }): Promise<PaymentDto> {
    const invoice = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: args.invoiceId, deletedAt: null },
          include: { customer: { select: { id: true } } },
        }),
      args.tenantId,
    );
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      throw new BadRequestException({
        code: 'invoice_not_payable',
        message: 'La factura no es cobrable en este estado',
      });
    }
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

    // Cargo via gateway, decryption del token dentro del withTenant para no
    // exfiltrar.
    const { paymentRow, chargeResult } = await this.prisma.withTenant(async (tx) => {
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
      // Multi-gateway: GoCardless cobra contra el mandato (queda `processing`
      // hasta el webhook); el resto va por el gateway por defecto (Stripe).
      const result =
        pm.gateway === 'gocardless'
          ? await this.goCardlessCharge.charge({
              tenantId: args.tenantId,
              mandateId: tokenPlain,
              amountCents: toCents(amount),
              currency: invoice.currency,
              description: `Factura ${invoice.invoiceNumber}`,
              metadata: { invoiceId: invoice.id, tenantId: args.tenantId },
            })
          : await this.gateway.charge({
              gatewayCustomerId: pm.gatewayCustomerId ?? '',
              paymentMethodToken: tokenPlain,
              paymentMethodType: pm.type,
              amountCents: toCents(amount),
              currency: invoice.currency,
              description: `Factura ${invoice.invoiceNumber}`,
              metadata: { invoiceId: invoice.id, tenantId: args.tenantId },
              offSession: true,
            });
      const status: PaymentStatus =
        result.status === 'succeeded'
          ? 'succeeded'
          : result.status === 'processing'
            ? 'processing'
            : result.status === 'requires_action'
              ? 'pending'
              : 'failed';
      const created = await tx.payment.create({
        data: {
          tenantId: args.tenantId,
          invoiceId: invoice.id,
          customerId: invoiceCustomerId,
          paymentMethodId: pm.id,
          amount,
          currency: invoice.currency,
          status,
          methodType: pm.type,
          gateway: pm.gateway,
          gatewayPaymentId: result.gatewayPaymentId,
          ...(result.status === 'succeeded' ? { paidAt: new Date() } : {}),
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        },
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
      // Sincronizar invoice si succeeded (la final llega del webhook tambien).
      if (status === 'succeeded') {
        const newPaid = addAmounts(invoice.amountPaid, amount);
        const fully = isAtLeast(newPaid, invoice.total);
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            amountPaid: newPaid,
            ...(fully ? { status: 'paid', paidAt: new Date() } : {}),
          },
        });
      }
      return { paymentRow: created, chargeResult: result };
    }, args.tenantId);

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
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findFirst({
          where: { gatewayPaymentId: args.gatewayPaymentId },
        }),
      args.tenantId,
    );
    if (!existing) {
      this.logger.warn(
        `Webhook recibido para payment desconocido ${args.gatewayPaymentId} (tenant ${args.tenantId})`,
      );
      return;
    }
    const terminalStatuses: PaymentStatus[] = ['succeeded', 'refunded', 'partially_refunded'];
    if (existing.status === args.newStatus || terminalStatuses.includes(existing.status)) {
      this.logger.log(
        `Webhook ignorado para payment ${existing.id}: status ${existing.status} -> ${args.newStatus} (duplicado o estado terminal)`,
      );
      return;
    }
    await this.prisma.withTenant(async (tx) => {
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          status: args.newStatus as PaymentStatus,
          ...(args.paidAt ? { paidAt: args.paidAt } : {}),
          ...(args.failureReason ? { failureReason: args.failureReason } : {}),
        },
      });
      if (args.newStatus === 'succeeded' && existing.invoiceId) {
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: existing.invoiceId },
        });
        const newPaid = addAmounts(invoice.amountPaid, existing.amount);
        const fully = isAtLeast(newPaid, invoice.total);
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            amountPaid: newPaid,
            ...(fully ? { status: 'paid', paidAt: args.paidAt ?? new Date() } : {}),
          },
        });
      }
    }, args.tenantId);
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
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findFirst({
          where: { gatewayPaymentId: args.gatewayPaymentId },
        }),
      args.tenantId,
    );
    if (!existing) {
      this.logger.warn(
        `charge.refunded para payment desconocido ${args.gatewayPaymentId} (tenant ${args.tenantId})`,
      );
      return;
    }
    const delta = subtractAmounts(args.amountRefunded, existing.refundedAmount);
    if (delta <= 0) {
      this.logger.log(
        `charge.refunded ignorado para payment ${existing.id}: acumulado ${args.amountRefunded} <= registrado ${Number(existing.refundedAmount)}`,
      );
      return;
    }
    const fullyRefunded = isAtLeast(args.amountRefunded, existing.amount);
    await this.prisma.withTenant(async (tx) => {
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          refundedAmount: args.amountRefunded,
          refundedAt: new Date(),
          status: fullyRefunded ? 'refunded' : 'partially_refunded',
        },
      });
      if (existing.invoiceId) {
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
    this.logger.log(
      `charge.refunded sincronizado: payment ${existing.id} refundedAmount=${args.amountRefunded} (delta ${delta.toFixed(2)})`,
    );
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
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findFirst({
          where: { gatewayPaymentId: args.gatewayPaymentId },
        }),
      args.tenantId,
    );
    if (!existing) {
      this.logger.warn(
        `charge.dispute para payment desconocido ${args.gatewayPaymentId} (tenant ${args.tenantId})`,
      );
      return;
    }
    if (existing.status !== 'succeeded') {
      this.logger.log(
        `charge.dispute ignorado para payment ${existing.id}: status ${existing.status} (solo se revierte succeeded)`,
      );
      return;
    }
    await this.prisma.withTenant(async (tx) => {
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          status: 'failed',
          failureReason: `disputed: ${args.reason ?? 'unknown'}`,
        },
      });
      if (existing.invoiceId) {
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
      };
    },
  ): PaymentDto {
    const customerName = row.customer
      ? row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre'
      : 'Inquilino';
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
