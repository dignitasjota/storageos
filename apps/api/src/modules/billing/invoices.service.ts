import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import { Queue } from 'bullmq';

import { addAmounts, isAtLeast, isGreaterThan, subtractAmounts, toCents } from '../../common/money';
import { isUniqueViolation } from '../../common/prisma-errors';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaService } from '../database/prisma.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payments/payment-gateway.interface';
import { JOB_VERIFACTU_SEND, QUEUE_VERIFACTU } from '../queues/queues.module';

import { InvoiceSeriesService } from './invoice-series.service';
import { VerifactuService } from './verifactu.service';

import type { VerifactuSendJobData } from './verifactu.processor';
import type { RequestMeta } from '../auth/auth.service';
import type { Invoice, InvoiceItem, InvoiceStatus, InvoiceType } from '@storageos/database';
import type {
  CancelInvoiceInput,
  CorrectionMethodValue,
  CreateInvoiceInput,
  CreateInvoiceItemInput,
  InvoiceDto,
  InvoiceItemDto,
  InvoiceStatusValue,
  InvoiceTypeValue,
  MarkPaidManuallyInput,
  RectifyInvoiceInput,
  RectifyInvoiceItemInput,
  RefundInvoiceInput,
  UpdateInvoiceInput,
} from '@storageos/shared';

const ALLOWED_TRANSITIONS: Record<InvoiceStatusValue, InvoiceStatusValue[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['paid', 'overdue', 'cancelled', 'refunded', 'partially_refunded'],
  overdue: ['paid', 'cancelled', 'refunded', 'partially_refunded'],
  paid: ['refunded', 'partially_refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
  cancelled: [],
};

type InvoiceWithRelations = Invoice & {
  items: InvoiceItem[];
  // Nullable desde Fase 13A.3 (F2 sin destinatario identificado).
  customer: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: 'individual' | 'business';
  } | null;
  contract: {
    contractNumber: string;
    unit: { id: string; code: string; facility: { id: string; name: string } } | null;
  } | null;
  series: { code: string };
  rectifiesInvoice: { id: string; invoiceNumber: string } | null;
  lateFeeInvoice: { id: string } | null;
};

interface ListFilters {
  status?: InvoiceStatusValue;
  customerId?: string;
  contractId?: string;
  overdue?: boolean;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  /** Opciones de retry para el envio Verifactu: 3 intentos con backoff exponencial. */
  private static readonly VERIFACTU_JOB_OPTS = {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 60_000 },
    removeOnComplete: { age: 86_400 },
    removeOnFail: false,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly series: InvoiceSeriesService,
    private readonly verifactu: VerifactuService,
    private readonly events: EventEmitter2,
    @InjectQueue(QUEUE_VERIFACTU) private readonly verifactuQueue: Queue<VerifactuSendJobData>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<InvoiceDto[]> {
    const where: Prisma.InvoiceWhereInput = { deletedAt: null };
    if (filters.status) where.status = filters.status as InvoiceStatus;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.contractId) where.contractId = filters.contractId;
    if (filters.overdue) {
      where.status = { in: ['issued', 'overdue'] };
      where.dueDate = { lt: new Date() };
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }],
          include: this.includeRelations(),
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<InvoiceDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(args: {
    tenantId: string;
    userId: string | null;
    input: CreateInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const invoiceType: 'F1' | 'F2' = args.input.invoiceType ?? 'F1';
    const { subtotal, taxAmount, total } = this.computeTotals(args.input.items);

    // Validacion F1 vs F2 (RD 1619/2012 art. 4 + 7).
    if (invoiceType === 'F1') {
      if (!args.input.customerId) {
        throw new BadRequestException({
          code: 'customer_required',
          message: 'En F1 el cliente es obligatorio',
        });
      }
    } else {
      // F2: limite 400€ general, hasta 3000€ con justificacion. AEAT no
      // exige cuantitativamente el motivo pero si que se justifique algo.
      const F2_DEFAULT_LIMIT = 400;
      const F2_JUSTIFIED_LIMIT = 3000;
      const justified = args.input.simplifiedJustification !== undefined;
      const limit = justified ? F2_JUSTIFIED_LIMIT : F2_DEFAULT_LIMIT;
      if (isGreaterThan(total, limit)) {
        throw new BadRequestException({
          code: 'f2_amount_limit_exceeded',
          message: justified
            ? `El total ${total.toFixed(2)}€ supera el limite F2 con justificacion (3000€)`
            : `El total ${total.toFixed(2)}€ supera el limite F2 sin justificacion (400€). Anade una justificacion para llegar a 3000€.`,
        });
      }
    }

    const created = await this.prisma
      .withTenant(async (tx) => {
        if (args.input.customerId) {
          const customer = await tx.customer.findFirst({
            where: { id: args.input.customerId, deletedAt: null },
          });
          if (!customer) {
            throw new NotFoundException({
              code: 'customer_not_found',
              message: 'Inquilino no encontrado',
            });
          }
        }
        const series = args.input.seriesId
          ? await tx.invoiceSeries.findUniqueOrThrow({ where: { id: args.input.seriesId } })
          : await tx.invoiceSeries.findFirst({
              where: { isDefault: true, isActive: true },
            });
        if (!series) {
          throw new BadRequestException({
            code: 'no_default_series',
            message: 'No hay serie por defecto configurada',
          });
        }
        // En draft NO se asigna invoiceNumber; se asigna al issue.
        const placeholderNumber = `DRAFT-${Date.now().toString(36)}`;
        const baseNotes = args.input.notes?.trim();
        // Si es F2 con justificacion, anotamos el motivo como prefijo del
        // campo notes para que quede trazable (no anadimos columna nueva,
        // por decision de modelo: F2 se deriva siempre de `invoice_type`).
        const finalNotes =
          invoiceType === 'F2' && args.input.simplifiedJustification
            ? `[F2:${args.input.simplifiedJustification}]${baseNotes ? ` ${baseNotes}` : ''}`
            : baseNotes || null;
        return tx.invoice.create({
          data: {
            tenantId: args.tenantId,
            ...(args.input.customerId ? { customerId: args.input.customerId } : {}),
            ...(args.input.contractId ? { contractId: args.input.contractId } : {}),
            seriesId: series.id,
            sequenceNumber: 0,
            invoiceNumber: placeholderNumber,
            status: 'draft',
            invoiceType,
            ...(args.input.issueDate ? { issueDate: new Date(args.input.issueDate) } : {}),
            ...(args.input.dueDate ? { dueDate: new Date(args.input.dueDate) } : {}),
            ...(args.input.periodStart ? { periodStart: new Date(args.input.periodStart) } : {}),
            ...(args.input.periodEnd ? { periodEnd: new Date(args.input.periodEnd) } : {}),
            subtotal,
            taxAmount,
            total,
            notes: finalNotes,
            verifactuMode: args.input.verifactuMode,
            items: {
              create: args.input.items.map((item, idx) =>
                this.toItemCreateData(item, args.tenantId, idx),
              ),
            },
          },
          include: this.includeRelations(),
        });
      }, args.tenantId)
      .catch((err: unknown) => {
        // Índice parcial invoices_recurring_period_unique: ya existe una F1 viva
        // para este contrato+periodo → 409 legible en vez de un 500.
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'duplicate_period_invoice',
            message: 'Ya existe una factura para este contrato y periodo',
          });
        }
        throw err;
      });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.created',
      entityType: 'Invoice',
      entityId: created.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    input: UpdateInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId);
    if (existing.status !== 'draft' && args.input.items !== undefined) {
      throw new BadRequestException({
        code: 'invoice_not_editable',
        message: 'Solo se pueden editar lineas en estado draft',
      });
    }
    const updated = await this.prisma.withTenant(async (tx) => {
      const data: Prisma.InvoiceUpdateInput = {};
      if (args.input.dueDate !== undefined) {
        data.dueDate = args.input.dueDate ? new Date(args.input.dueDate) : null;
      }
      if (args.input.notes !== undefined) {
        data.notes = args.input.notes?.trim() || null;
      }
      if (args.input.items !== undefined) {
        const totals = this.computeTotals(args.input.items);
        data.subtotal = totals.subtotal;
        data.taxAmount = totals.taxAmount;
        data.total = totals.total;
        await tx.invoiceItem.deleteMany({ where: { invoiceId: args.invoiceId } });
        await tx.invoiceItem.createMany({
          data: args.input.items.map((item, idx) => ({
            ...this.toItemCreateData(item, args.tenantId, idx),
            invoiceId: args.invoiceId,
          })),
        });
      }
      return tx.invoice.update({
        where: { id: args.invoiceId },
        data,
        include: this.includeRelations(),
      });
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.updated',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Emite la factura: asigna numero secuencial, calcula hash Verifactu
   * encadenado, marca `status = issued`, dispara envio AEAT (stub en
   * Fase 4). Todo en una transaccion.
   */
  async issue(args: {
    tenantId: string;
    userId: string | null;
    invoiceId: string;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId);
    this.assertTransition(existing.status as InvoiceStatusValue, 'issued');

    const updated = await this.prisma.withTenant(async (tx) => {
      const { sequenceNumber, series } = await this.series.reserveNextNumber(tx, existing.seriesId);
      const invoiceNumber = this.series.formatInvoiceNumber(series, sequenceNumber);
      const issueDate = existing.issueDate ?? new Date();
      const dueDate = existing.dueDate ?? this.computeDefaultDueDate(issueDate);

      // Verifactu hash encadenado.
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: args.tenantId },
        select: { taxId: true },
      });
      const total = Number(existing.total);
      const { hash, previousHash } = await this.verifactu.computeChainedHash(tx, {
        tenantId: args.tenantId,
        tenantTaxId: tenant.taxId ?? 'PENDIENTE',
        seriesId: existing.seriesId,
        invoiceNumber,
        issueDate,
        total,
      });
      const qrCodeUrl = await this.verifactu.buildQrDataUrl({
        tenantTaxId: tenant.taxId ?? 'PENDIENTE',
        invoiceNumber,
        issueDate,
        total,
      });

      return tx.invoice.update({
        where: { id: args.invoiceId },
        data: {
          status: 'issued',
          invoiceNumber,
          sequenceNumber,
          issueDate,
          dueDate,
          hash,
          previousHash,
          qrCodeUrl,
          aeatStatus: 'pending',
        },
        include: this.includeRelations(),
      });
    }, args.tenantId);

    // Encolar el envio AEAT en BullMQ con retry exponencial. El worker
    // (VerifactuProcessor) consumira el job de forma asincrona. Solo
    // reintenta cuando AEAT devuelve `status='error'` (fallo tecnico).
    await this.verifactuQueue.add(
      JOB_VERIFACTU_SEND,
      { invoiceId: updated.id, tenantId: args.tenantId },
      InvoicesService.VERIFACTU_JOB_OPTS,
    );

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.issued',
      entityType: 'Invoice',
      entityId: updated.id,
      changes: { invoiceNumber: updated.invoiceNumber, total: Number(updated.total) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    // Evento de dominio: dispara automations, webhooks salientes
    // (invoice.issued) y el auto-charge opt-in del tenant.
    const issuedPayload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'invoice',
      entityId: updated.id,
      customerId: updated.customerId,
      recipientEmail: null,
      scope: {
        invoice: {
          number: updated.invoiceNumber,
          total: Number(updated.total).toFixed(2),
          issueDate: updated.issueDate ? updated.issueDate.toISOString() : null,
        },
      },
    };
    this.events.emit(DOMAIN_EVENTS.invoice_issued, issuedPayload);
    return this.toDto(await this.findOrThrow(args.tenantId, updated.id));
  }

  /**
   * Recargo por mora: emite una FACTURA SEPARADA (F1, línea sin IVA — el
   * recargo es indemnizatorio) por el % del importe vencido o un € fijo,
   * según la config del tenant. Idempotente: una sola por factura original
   * (constraint único en `late_fee_for_invoice_id`).
   */
  async createLateFee(args: {
    tenantId: string;
    invoiceId: string;
    userId: string | null;
  }): Promise<InvoiceDto> {
    const { tenantId, invoiceId } = args;
    const { customerId, invoiceLabel, fee } = await this.prisma.withTenant(async (tx) => {
      const original = await tx.invoice.findFirst({
        where: { id: invoiceId, tenantId },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          customerId: true,
          total: true,
          lateFeeInvoice: { select: { id: true } },
        },
      });
      if (!original) {
        throw new NotFoundException({
          code: 'invoice_not_found',
          message: 'Factura no encontrada',
        });
      }
      if (original.lateFeeInvoice) {
        throw new ConflictException({
          code: 'late_fee_already_applied',
          message: 'Esta factura ya tiene un recargo por mora',
        });
      }
      if (!original.customerId) {
        throw new BadRequestException({
          code: 'customer_required',
          message: 'La factura no tiene cliente al que recargar',
        });
      }
      if (original.status !== 'issued' && original.status !== 'overdue') {
        throw new BadRequestException({
          code: 'invoice_not_chargeable',
          message: 'Solo se aplica recargo a facturas emitidas o vencidas',
        });
      }
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { lateFeeType: true, lateFeeValue: true },
      });
      const base = Number(original.total);
      const value = Number(tenant.lateFeeValue);
      // Cálculo en céntimos enteros: base*% sobre floats arrastra drift al recargo.
      const fee =
        tenant.lateFeeType === 'percentage'
          ? Math.round(toCents(base) * (value / 100)) / 100
          : toCents(value) / 100;
      if (fee <= 0) {
        throw new BadRequestException({
          code: 'late_fee_zero',
          message: 'El recargo configurado es 0',
        });
      }
      return {
        customerId: original.customerId,
        invoiceLabel: original.invoiceNumber ?? original.id,
        fee,
      };
    }, tenantId);

    const series = await this.series.getDefault(tenantId);
    if (!series) {
      throw new BadRequestException({
        code: 'no_default_series',
        message: 'No hay serie de facturación por defecto',
      });
    }

    const created = await this.create({
      tenantId,
      userId: args.userId,
      input: {
        invoiceType: 'F1',
        customerId,
        seriesId: series.id,
        items: [
          {
            description: `Recargo por mora — factura ${invoiceLabel}`,
            quantity: 1,
            unitPrice: fee,
            taxRate: 0,
          },
        ],
        verifactuMode: 'verifactu',
      },
      meta: {},
    });
    // Enlazar a la original (idempotencia) y emitir.
    await this.prisma.withTenant(
      (tx) =>
        tx.invoice.update({ where: { id: created.id }, data: { lateFeeForInvoiceId: invoiceId } }),
      tenantId,
    );
    return this.issue({ tenantId, userId: args.userId, invoiceId: created.id, meta: {} });
  }

  /**
   * Reencola el envio a AEAT de una factura ya emitida. Resetea los
   * campos `aeat_*` para que el worker arranque desde cero. Usado desde
   * el badge Verifactu del frontend cuando un envio quedo en `error` o
   * `rejected` y queremos reintentar tras corregir datos.
   */
  async resendAeat(
    invoiceId: string,
    tenantId: string,
  ): Promise<{ queued: true; invoiceId: string }> {
    const existing = await this.findOrThrow(tenantId, invoiceId);
    if (existing.status === 'draft') {
      throw new BadRequestException({
        code: 'invoice_draft_not_sendable',
        message: 'No se puede reenviar a AEAT una factura en borrador',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.invoice.update({
          where: { id: invoiceId },
          data: {
            aeatSentAt: null,
            aeatStatus: null,
            aeatCsv: null,
            aeatResponse: Prisma.JsonNull,
          },
        }),
      tenantId,
    );
    await this.verifactuQueue.add(
      JOB_VERIFACTU_SEND,
      { invoiceId, tenantId },
      InvoicesService.VERIFACTU_JOB_OPTS,
    );
    this.logger.log(`[verifactu] reenvio encolado para invoice ${invoiceId} (tenant ${tenantId})`);
    return { queued: true, invoiceId };
  }

  /**
   * Consulta a AEAT el estado actual de la factura (sub-bloque 15A.1).
   * Llama a `VerifactuService.refreshStatus` y devuelve el DTO actualizado
   * para que la UI pueda refrescar el badge inmediatamente. Usado por el
   * boton "Consultar AEAT" del badge cuando la factura quedo `pending`
   * o `error`.
   */
  async refreshAeatStatus(invoiceId: string, tenantId: string): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(tenantId, invoiceId);
    if (existing.status === 'draft') {
      throw new BadRequestException({
        code: 'invoice_draft_not_sendable',
        message: 'No se puede consultar a AEAT una factura en borrador',
      });
    }
    await this.verifactu.refreshStatus(invoiceId, tenantId);
    return this.toDto(await this.findOrThrow(tenantId, invoiceId));
  }

  async cancel(args: {
    tenantId: string;
    /** `null` cuando lo lanza un proceso automático (cron de bookings impagados). */
    userId: string | null;
    invoiceId: string;
    input: CancelInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId);
    this.assertTransition(existing.status as InvoiceStatusValue, 'cancelled');
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.update({
          where: { id: args.invoiceId },
          data: { status: 'cancelled', cancelledAt: new Date() },
          include: this.includeRelations(),
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.cancelled',
      entityType: 'Invoice',
      entityId: updated.id,
      changes: { reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /** Marca una factura como pagada manualmente (cobro en efectivo, transferencia...). */
  async markPaidManually(args: {
    tenantId: string;
    userId: string | null;
    invoiceId: string;
    input: MarkPaidManuallyInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId);
    if (existing.status !== 'issued' && existing.status !== 'overdue') {
      throw new BadRequestException({
        code: 'invoice_not_payable',
        message: 'La factura no esta en estado pagable',
      });
    }
    const amount = args.input.amount;
    const total = Number(existing.total);
    const newPaid = addAmounts(existing.amountPaid, amount);
    if (isGreaterThan(newPaid, total)) {
      throw new BadRequestException({
        code: 'overpayment',
        message: 'El importe excede el pendiente',
      });
    }
    const fullyPaid = isAtLeast(newPaid, total);
    const paidAt = args.input.paidAt ? new Date(args.input.paidAt) : new Date();

    const updated = await this.prisma.withTenant(async (tx) => {
      // En F2 sin destinatario no podemos crear un Payment (la tabla
      // exige customer_id). Solo actualizamos el contador agregado de
      // la factura; el cobro queda registrado en `amountPaid`.
      if (existing.customerId) {
        await tx.payment.create({
          data: {
            tenantId: args.tenantId,
            invoiceId: args.invoiceId,
            customerId: existing.customerId,
            amount,
            methodType: args.input.methodType,
            gateway: 'manual',
            status: 'succeeded',
            paidAt,
            notes: args.input.notes?.trim() || null,
          },
        });
      }
      return tx.invoice.update({
        where: { id: args.invoiceId },
        data: {
          amountPaid: newPaid,
          ...(fullyPaid ? { status: 'paid', paidAt } : {}),
        },
        include: this.includeRelations(),
      });
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: fullyPaid ? 'invoice.paid' : 'invoice.partial_payment',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      changes: { amount, methodType: args.input.methodType },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    if (fullyPaid) {
      const payload: DomainEventPayload = {
        tenantId: args.tenantId,
        entityType: 'invoice',
        entityId: args.invoiceId,
        customerId: existing.customerId,
        recipientEmail: null,
        scope: {
          invoice: {
            number: updated.invoiceNumber,
            total: total.toFixed(2),
            paidAt: paidAt.toISOString(),
          },
        },
      };
      this.events.emit(DOMAIN_EVENTS.invoice_paid, payload);
    }
    return this.toDto(updated);
  }

  /**
   * Revierte un cobro (p. ej. una **devolución SEPA** detectada en la
   * conciliación N43): resta el importe de `amountPaid`, marca los pagos con
   * éxito como fallidos y devuelve la factura a `overdue`/`issued`. Mismo patrón
   * que el revert de disputas Stripe.
   */
  async revertPayment(args: {
    tenantId: string;
    userId: string | null;
    invoiceId: string;
    amount: number;
    reason: string;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId);
    if (Number(existing.amountPaid) <= 0) {
      throw new BadRequestException({
        code: 'nothing_to_revert',
        message: 'La factura no tiene cobros que revertir',
      });
    }
    const newPaid = Math.max(0, subtractAmounts(existing.amountPaid, args.amount));
    const wasPaid = existing.status === 'paid';
    const revertedStatus = wasPaid
      ? existing.dueDate && existing.dueDate.getTime() < Date.now()
        ? 'overdue'
        : 'issued'
      : existing.status;

    const updated = await this.prisma.withTenant(async (tx) => {
      await tx.payment.updateMany({
        where: { invoiceId: args.invoiceId, status: 'succeeded' },
        data: { status: 'failed', failureReason: args.reason },
      });
      return tx.invoice.update({
        where: { id: args.invoiceId },
        data: {
          amountPaid: newPaid,
          status: revertedStatus,
          ...(wasPaid ? { paidAt: null } : {}),
        },
        include: this.includeRelations(),
      });
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.payment_reverted',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      changes: { amount: args.amount, reason: args.reason, revertedStatus },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async refund(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    input: RefundInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId);
    if (existing.status !== 'paid' && existing.status !== 'partially_refunded') {
      throw new BadRequestException({
        code: 'invoice_not_refundable',
        message: 'Solo se pueden reembolsar facturas pagadas',
      });
    }
    const amount = args.input.amount;
    const total = Number(existing.total);
    const newRefunded = addAmounts(existing.amountRefunded, amount);
    if (isGreaterThan(newRefunded, total)) {
      throw new BadRequestException({
        code: 'over_refund',
        message: 'El importe excede el cobrado',
      });
    }
    const fullyRefunded = isAtLeast(newRefunded, total);

    // Si la factura se cobró por pasarela (Stripe/SEPA), devolvemos el dinero DE
    // VERDAD antes de tocar la BD: buscamos el payment con `gatewayPaymentId` que
    // tenga saldo reembolsable. Sin esto, el botón «Reembolsar» solo marcaba la
    // factura en BD y el dinero nunca salía del gateway.
    const gatewayPayment = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findFirst({
          where: {
            invoiceId: args.invoiceId,
            gatewayPaymentId: { not: null },
            status: { in: ['succeeded', 'partially_refunded'] },
          },
          orderBy: { createdAt: 'desc' },
        }),
      args.tenantId,
    );

    let gatewayRefundId: string | null = null;
    if (gatewayPayment?.gatewayPaymentId) {
      const paymentRefundable = subtractAmounts(
        gatewayPayment.amount,
        gatewayPayment.refundedAmount,
      );
      if (isGreaterThan(amount, paymentRefundable)) {
        throw new BadRequestException({
          code: 'over_refund_gateway',
          message: 'El importe excede lo cobrado por la pasarela para este pago',
        });
      }
      const result = await this.gateway.refund({
        gatewayPaymentId: gatewayPayment.gatewayPaymentId,
        amountCents: toCents(amount),
        ...(args.input.reason ? { reason: args.input.reason } : {}),
      });
      if (result.status === 'failed') {
        throw new BadRequestException({
          code: 'gateway_refund_failed',
          message: 'La pasarela rechazó el reembolso; no se ha devuelto el dinero',
        });
      }
      gatewayRefundId = result.gatewayRefundId;
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      // Actualizamos también `payment.refundedAmount` cuando el reembolso pasó
      // por la pasarela: el webhook `charge.refunded` sincroniza por delta contra
      // este campo, así que dejarlo al día evita el DOBLE cómputo (el webhook
      // llegaría después y volvería a sumar el importe sobre la factura).
      if (gatewayPayment) {
        const newPaymentRefunded = addAmounts(gatewayPayment.refundedAmount, amount);
        const paymentFully = isAtLeast(newPaymentRefunded, gatewayPayment.amount);
        await tx.payment.update({
          where: { id: gatewayPayment.id },
          data: {
            refundedAmount: newPaymentRefunded,
            refundedAt: new Date(),
            status: paymentFully ? 'refunded' : 'partially_refunded',
          },
        });
      }
      return tx.invoice.update({
        where: { id: args.invoiceId },
        data: {
          amountRefunded: newRefunded,
          status: fullyRefunded ? 'refunded' : 'partially_refunded',
        },
        include: this.includeRelations(),
      });
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.refunded',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      changes: {
        amount,
        fully: fullyRefunded,
        reason: args.input.reason ?? null,
        gateway: gatewayPayment ? true : false,
        gatewayRefundId,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Emite una factura rectificativa (R1-R5) que rectifica una factura
   * original ya emitida. Metodo soportado: `by_differences` (los items
   * representan la diferencia respecto a la original; pueden ser
   * negativos). La rectificativa se crea en estado `draft` — el usuario
   * debera emitirla explicitamente para que se asigne numero, hash y se
   * envie a AEAT.
   *
   * Restricciones AEAT (RD 1619/2012 art. 13):
   *   - La factura original debe estar emitida (no draft ni cancelled).
   *   - No se permite rectificar una rectificativa (MVP).
   *   - Se hereda customerId + seriesId del original.
   */
  async rectify(args: {
    originalInvoiceId: string;
    tenantId: string;
    userId: string;
    input: RectifyInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const original = await this.findOrThrow(args.tenantId, args.originalInvoiceId);

    if (original.status === 'draft' || original.status === 'cancelled') {
      throw new BadRequestException({
        code: 'invoice_not_rectifiable',
        message: 'Solo se pueden rectificar facturas emitidas',
      });
    }
    // Solo se permite rectificar facturas no-rectificativas. F1 y F2
    // son rectificables; las R1-R5 no se vuelven a rectificar (MVP).
    if (original.invoiceType !== 'F1' && original.invoiceType !== 'F2') {
      throw new BadRequestException({
        code: 'invoice_not_rectifiable',
        message: 'No se puede rectificar una factura rectificativa',
      });
    }

    const correctionMethod: CorrectionMethodValue = args.input.correctionMethod ?? 'by_differences';
    const { subtotal, taxAmount, total } = this.computeTotalsRectify(args.input.items);
    const placeholderNumber = `DRAFT-${Date.now().toString(36)}`;

    const created = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.create({
          data: {
            tenantId: args.tenantId,
            ...(original.customerId ? { customerId: original.customerId } : {}),
            ...(original.contractId ? { contractId: original.contractId } : {}),
            seriesId: original.seriesId,
            sequenceNumber: 0,
            invoiceNumber: placeholderNumber,
            status: 'draft',
            invoiceType: args.input.rectificationType as InvoiceType,
            rectifiesInvoiceId: original.id,
            rectificationReason: args.input.reason.trim(),
            correctionMethod,
            verifactuMode: original.verifactuMode,
            ...(args.input.issueDate ? { issueDate: new Date(args.input.issueDate) } : {}),
            subtotal,
            taxAmount,
            total,
            items: {
              create: args.input.items.map((item, idx) =>
                this.toRectifyItemCreateData(item, args.tenantId, idx),
              ),
            },
          },
          include: this.includeRelations(),
        }),
      args.tenantId,
    );

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.rectified',
      entityType: 'Invoice',
      entityId: created.id,
      changes: {
        originalInvoiceId: original.id,
        originalInvoiceNumber: original.invoiceNumber,
        rectificationType: args.input.rectificationType,
        correctionMethod,
        reason: args.input.reason.trim(),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    // Notificar a automations. La rectificativa esta en draft, pero el
    // evento permite (p.ej.) avisar al cliente o crear tareas internas.
    const payload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'invoice',
      entityId: created.id,
      customerId: original.customerId,
      recipientEmail: null,
      scope: {
        invoice: {
          rectificationType: args.input.rectificationType,
          reason: args.input.reason.trim(),
          total: total.toFixed(2),
          original: {
            id: original.id,
            number: original.invoiceNumber,
          },
        },
      },
    };
    this.events.emit(DOMAIN_EVENTS.invoice_rectified, payload);

    return this.toDto(created);
  }

  /** Persiste la URL del PDF tras generarlo. */
  async attachPdf(args: { tenantId: string; invoiceId: string; pdfUrl: string }): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.invoice.update({
          where: { id: args.invoiceId },
          data: { pdfUrl: args.pdfUrl },
        }),
      args.tenantId,
    );
  }

  /** Marca como `overdue` las facturas issued con dueDate ya vencida. */
  async markOverdueDue(tenantId: string): Promise<{ updated: number }> {
    const result = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.updateMany({
          where: {
            status: 'issued',
            dueDate: { lt: new Date() },
          },
          data: { status: 'overdue' },
        }),
      tenantId,
    );
    return { updated: result.count };
  }

  private async findOrThrow(tenantId: string, id: string): Promise<InvoiceWithRelations> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id, deletedAt: null },
          include: this.includeRelations(),
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'invoice_not_found',
        message: 'Factura no encontrada',
      });
    }
    return row;
  }

  private assertTransition(from: InvoiceStatusValue, to: InvoiceStatusValue): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException({
        code: 'invalid_invoice_transition',
        message: `Transicion invalida: ${from} -> ${to}`,
      });
    }
  }

  private includeRelations() {
    return {
      items: { orderBy: { position: 'asc' as const } },
      customer: {
        select: {
          firstName: true,
          lastName: true,
          companyName: true,
          customerType: true,
        },
      },
      contract: {
        select: {
          contractNumber: true,
          unit: {
            select: { id: true, code: true, facility: { select: { id: true, name: true } } },
          },
        },
      },
      series: { select: { code: true } },
      rectifiesInvoice: { select: { id: true, invoiceNumber: true } },
      lateFeeInvoice: { select: { id: true } },
    } as const;
  }

  private computeTotals(items: CreateInvoiceItemInput[]): {
    subtotal: number;
    taxAmount: number;
    total: number;
  } {
    // Redondeo POR LÍNEA (el mismo criterio que `toItemCreateData`): la
    // cabecera debe ser la suma EXACTA de las líneas ya redondeadas, o con
    // varias líneas los totales de la factura difieren céntimos de la suma de
    // sus items (y AEAT/Veri*Factu exige que cuadren). total = Σ totales de
    // línea; cuota = Σ cuotas de línea; base = total − cuota.
    let taxCents = 0;
    let totalCents = 0;
    for (const it of items) {
      const lineSubtotal = it.quantity * it.unitPrice;
      const lineTax = (lineSubtotal * it.taxRate) / 100;
      taxCents += Math.round(lineTax * 100);
      totalCents += Math.round((lineSubtotal + lineTax) * 100);
    }
    return {
      subtotal: (totalCents - taxCents) / 100,
      taxAmount: taxCents / 100,
      total: totalCents / 100,
    };
  }

  private toItemCreateData(
    item: CreateInvoiceItemInput,
    tenantId: string,
    position: number,
  ): Prisma.InvoiceItemUncheckedCreateWithoutInvoiceInput {
    const lineSubtotal = item.quantity * item.unitPrice;
    const lineTax = (lineSubtotal * item.taxRate) / 100;
    return {
      tenantId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
      taxAmount: Math.round(lineTax * 100) / 100,
      total: Math.round((lineSubtotal + lineTax) * 100) / 100,
      ...(item.relatedContractId ? { relatedContractId: item.relatedContractId } : {}),
      ...(item.relatedUnitId ? { relatedUnitId: item.relatedUnitId } : {}),
      ...(item.periodStart ? { periodStart: new Date(item.periodStart) } : {}),
      ...(item.periodEnd ? { periodEnd: new Date(item.periodEnd) } : {}),
      position,
    };
  }

  /**
   * Variante de `computeTotals` para rectificativas: el `unitPrice` puede
   * ser negativo (la rectificativa "por diferencias" puede reducir
   * importes). El total resultante puede tambien ser negativo.
   */
  private computeTotalsRectify(items: RectifyInvoiceItemInput[]): {
    subtotal: number;
    taxAmount: number;
    total: number;
  } {
    // Redondeo POR LÍNEA (el mismo criterio que `toItemCreateData`): la
    // cabecera debe ser la suma EXACTA de las líneas ya redondeadas, o con
    // varias líneas los totales de la factura difieren céntimos de la suma de
    // sus items (y AEAT/Veri*Factu exige que cuadren). total = Σ totales de
    // línea; cuota = Σ cuotas de línea; base = total − cuota.
    let taxCents = 0;
    let totalCents = 0;
    for (const it of items) {
      const lineSubtotal = it.quantity * it.unitPrice;
      const lineTax = (lineSubtotal * it.taxRate) / 100;
      taxCents += Math.round(lineTax * 100);
      totalCents += Math.round((lineSubtotal + lineTax) * 100);
    }
    return {
      subtotal: (totalCents - taxCents) / 100,
      taxAmount: taxCents / 100,
      total: totalCents / 100,
    };
  }

  private toRectifyItemCreateData(
    item: RectifyInvoiceItemInput,
    tenantId: string,
    position: number,
  ): Prisma.InvoiceItemUncheckedCreateWithoutInvoiceInput {
    const lineSubtotal = item.quantity * item.unitPrice;
    const lineTax = (lineSubtotal * item.taxRate) / 100;
    return {
      tenantId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
      taxAmount: Math.round(lineTax * 100) / 100,
      total: Math.round((lineSubtotal + lineTax) * 100) / 100,
      ...(item.relatedContractId ? { relatedContractId: item.relatedContractId } : {}),
      ...(item.relatedUnitId ? { relatedUnitId: item.relatedUnitId } : {}),
      ...(item.periodStart ? { periodStart: new Date(item.periodStart) } : {}),
      ...(item.periodEnd ? { periodEnd: new Date(item.periodEnd) } : {}),
      position,
    };
  }

  private computeDefaultDueDate(issueDate: Date): Date {
    const due = new Date(issueDate);
    // UTC como el resto de fechas de facturación (setDate usa la TZ local del
    // servidor y podía mover el vencimiento un día según la hora de emisión).
    due.setUTCDate(due.getUTCDate() + 15);
    return due;
  }

  private toDto(row: InvoiceWithRelations): InvoiceDto {
    // F2 puede no tener customer: el DTO devuelve null para que el front
    // muestre un placeholder "Sin identificar".
    let customerName: string | null = null;
    if (row.customer) {
      customerName =
        row.customer.customerType === 'business'
          ? (row.customer.companyName ?? 'Empresa')
          : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
            'Sin nombre';
    }
    const total = Number(row.total);
    const amountPaid = Number(row.amountPaid);
    const amountRefunded = Number(row.amountRefunded);
    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      seriesId: row.seriesId,
      seriesCode: row.series.code,
      sequenceNumber: row.sequenceNumber,
      customerId: row.customerId,
      customerName,
      contractId: row.contractId,
      contractNumber: row.contract?.contractNumber ?? null,
      unitId: row.contract?.unit?.id ?? null,
      unitCode: row.contract?.unit?.code ?? null,
      facilityId: row.contract?.unit?.facility?.id ?? null,
      facilityName: row.contract?.unit?.facility?.name ?? null,
      status: row.status as InvoiceStatusValue,
      invoiceType: row.invoiceType as InvoiceTypeValue,
      rectifiesInvoiceId: row.rectifiesInvoiceId,
      rectifiesInvoiceNumber: row.rectifiesInvoice?.invoiceNumber ?? null,
      lateFeeForInvoiceId: row.lateFeeForInvoiceId,
      lateFeeInvoiceId: row.lateFeeInvoice?.id ?? null,
      rectificationReason: row.rectificationReason,
      correctionMethod: row.correctionMethod as CorrectionMethodValue | null,
      issueDate: row.issueDate ? row.issueDate.toISOString().slice(0, 10) : null,
      dueDate: row.dueDate ? row.dueDate.toISOString().slice(0, 10) : null,
      periodStart: row.periodStart ? row.periodStart.toISOString().slice(0, 10) : null,
      periodEnd: row.periodEnd ? row.periodEnd.toISOString().slice(0, 10) : null,
      subtotal: Number(row.subtotal),
      taxAmount: Number(row.taxAmount),
      total,
      amountPaid,
      amountRefunded,
      amountPending: Math.max(0, total - amountPaid),
      currency: row.currency,
      pdfUrl: row.pdfUrl,
      notes: row.notes,
      hash: row.hash,
      previousHash: row.previousHash,
      qrCodeUrl: row.qrCodeUrl,
      verifactuMode: row.verifactuMode,
      aeatSentAt: row.aeatSentAt ? row.aeatSentAt.toISOString() : null,
      aeatStatus: row.aeatStatus,
      aeatCsv: row.aeatCsv,
      holdedDocumentId: row.holdedDocumentId,
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      items: row.items.map((it) => this.toItemDto(it)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toItemDto(item: InvoiceItem): InvoiceItemDto {
    return {
      id: item.id,
      description: item.description,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      taxRate: Number(item.taxRate),
      taxAmount: Number(item.taxAmount),
      total: Number(item.total),
      relatedContractId: item.relatedContractId,
      relatedUnitId: item.relatedUnitId,
      periodStart: item.periodStart ? item.periodStart.toISOString().slice(0, 10) : null,
      periodEnd: item.periodEnd ? item.periodEnd.toISOString().slice(0, 10) : null,
      position: item.position,
    };
  }
}
