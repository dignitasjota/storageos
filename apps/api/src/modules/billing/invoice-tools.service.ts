import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NON_CASH_PAYMENT_METHODS } from '@storageos/shared';

import { ACCESS_CUT_APPLIED_WHERE } from '../../common/access-cut';
import { todayInTimezone } from '../../common/format';
import { toCents } from '../../common/money';
import { CHARGEABLE_MANDATE_WHERE, hasPaymentInFlight } from '../../common/sepa-remittance-guard';
import { tenantFiscalDataMissing } from '../../common/tenant-readiness';
import { AuditService } from '../auth/audit.service';
import { CustomerEmailsService } from '../customer-emails/customer-emails.service';
import { overdueInvoiceWhere } from '../dashboard/today-filters';
import { PrismaService } from '../database/prisma.service';

import { BillingJobsService } from './billing-jobs.service';
import {
  INVOICE_PDF_REQUESTED,
  InvoicesService,
  type InvoicePdfRequestedPayload,
} from './invoices.service';
import { REMINDER_SOURCES, SUMMARY_REMINDER_SOURCES } from './reminder-summary';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type {
  CorrectPaymentInput,
  InvoiceActivityDto,
  InvoiceCancelPreviewDto,
  InvoiceCollectionDto,
  InvoiceDto,
  InvoiceRefundOptionsDto,
  InvoiceRefundVia,
  InvoiceSavedViewDto,
  MonthCloseDto,
  MonthCloseGenerateResultDto,
  MonthCloseRowDto,
  MonthCloseWarning,
  PaymentRecordMethodValue,
  PaymentStatusValue,
  SaveInvoiceViewInput,
  SendInvoiceEmailInput,
  SendInvoiceEmailResultDto,
} from '@storageos/shared';

/** Un cobro registrado a mano que es dinero (no retención ni compensación). */
const MANUAL_MONEY = {
  gateway: 'manual',
  methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
} satisfies Prisma.PaymentWhereInput;

/**
 * Lo que la ficha y la lista de facturas necesitan además de la factura: su
 * actividad, el estado real del cobro, corregir o deshacer un cobro, duplicar,
 * qué pasará al anular, cómo se devuelve el dinero, enviarla por correo, el
 * cierre del mes y las vistas guardadas.
 */
@Injectable()
export class InvoiceToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly billingJobs: BillingJobsService,
    private readonly customerEmails: CustomerEmailsService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  // -------------------------------------------------------------------------
  // Estado real del cobro (lista y ficha)
  // -------------------------------------------------------------------------

  async withCollection(tenantId: string, rows: InvoiceDto[]): Promise<InvoiceDto[]> {
    const states = await this.collectionStates(
      tenantId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({ ...r, collection: states.get(r.id) ?? emptyCollection() }));
  }

  async collectionStates(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, InvoiceCollectionDto>> {
    const out = new Map<string, InvoiceCollectionDto>();
    if (ids.length === 0) return out;
    await this.prisma.withTenant(async (tx) => {
      const [inFlight, remittance, plans, reminders, summaries] = await Promise.all([
        tx.payment.findMany({
          where: { invoiceId: { in: ids }, status: { in: ['pending', 'processing'] } },
          select: { invoiceId: true },
        }),
        tx.sepaRemittanceItem.findMany({
          where: { invoiceId: { in: ids }, status: 'pending' },
          select: { invoiceId: true },
        }),
        tx.paymentPlan.findMany({
          where: { status: 'active', invoiceIds: { hasSome: ids } },
          select: { invoiceIds: true },
        }),
        tx.communication.groupBy({
          by: ['invoiceId'],
          where: {
            invoiceId: { in: ids },
            source: { in: REMINDER_SOURCES },
            status: { notIn: ['failed', 'skipped'] },
          },
          _max: { createdAt: true },
        }),
        tx.communication.findMany({
          where: {
            source: { in: SUMMARY_REMINDER_SOURCES },
            status: { notIn: ['failed', 'skipped'] },
            OR: ids.map((id) => ({
              variables: { path: ['invoiceIds'], array_contains: [id] },
            })),
          },
          select: { variables: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 500,
        }),
      ]);
      for (const id of ids) out.set(id, emptyCollection());
      for (const p of inFlight) if (p.invoiceId) out.get(p.invoiceId)!.inFlight = true;
      for (const r of remittance) out.get(r.invoiceId)!.inRemittance = true;
      for (const plan of plans) {
        for (const id of plan.invoiceIds) {
          const state = out.get(id);
          if (state) state.inPaymentPlan = true;
        }
      }
      const later = (id: string, at: Date) => {
        const state = out.get(id);
        if (!state) return;
        if (!state.lastReminderAt || at.toISOString() > state.lastReminderAt) {
          state.lastReminderAt = at.toISOString();
        }
      };
      for (const r of reminders)
        if (r.invoiceId && r._max.createdAt) later(r.invoiceId, r._max.createdAt);
      for (const s of summaries) {
        const list = (s.variables as { invoiceIds?: unknown } | null)?.invoiceIds;
        if (Array.isArray(list))
          for (const id of list) if (typeof id === 'string') later(id, s.createdAt);
      }
    }, tenantId);
    return out;
  }

  // -------------------------------------------------------------------------
  // Actividad de una factura
  // -------------------------------------------------------------------------

  async activity(
    tenantId: string,
    invoiceId: string,
    facilityScope?: string[] | null,
  ): Promise<InvoiceActivityDto> {
    await this.invoices.detail(tenantId, invoiceId, facilityScope);
    return this.prisma.withTenant(async (tx) => {
      const [payments, refunds, communications, dunning, history] = await Promise.all([
        tx.payment.findMany({
          where: { invoiceId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        tx.invoiceRefund.findMany({
          where: { invoiceId },
          orderBy: { createdAt: 'asc' },
          include: {
            createdBy: { select: { fullName: true } },
            payment: { select: { methodType: true } },
          },
        }),
        tx.communication.findMany({
          where: {
            OR: [
              { invoiceId },
              {
                source: { in: SUMMARY_REMINDER_SOURCES },
                variables: { path: ['invoiceIds'], array_contains: [invoiceId] },
              },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        tx.dunningAction.findMany({
          where: { invoiceId },
          orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        }),
        tx.auditLog.findMany({
          where: { entityType: 'Invoice', entityId: invoiceId },
          orderBy: { occurredAt: 'asc' },
          include: { user: { select: { fullName: true } } },
          take: 200,
        }),
      ]);
      const locks = await paymentLocks(
        tx,
        payments.map((p) => p.id),
      );
      // Los deshechos (registrados por error) los marca el registro.
      const undone = new Set<string>();
      for (const h of history) {
        if (h.action !== 'invoice.payment_undone') continue;
        const ids = (h.changes as { paymentIds?: unknown } | null)?.paymentIds;
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') undone.add(id);
      }
      return {
        payments: payments.map((p) => {
          const isUndone = undone.has(p.id);
          return {
            id: p.id,
            amount: Number(p.amount),
            methodType: p.methodType as PaymentRecordMethodValue,
            gateway: p.gateway,
            status: p.status as PaymentStatusValue,
            paidAt: p.paidAt?.toISOString() ?? null,
            refundedAmount: Number(p.refundedAmount),
            returnedAt: p.returnedAt?.toISOString() ?? null,
            failureReason: p.failureReason,
            notes: p.notes,
            createdAt: p.createdAt.toISOString(),
            editable: isEditable(p) && !isUndone && !locks.has(p.id),
            lockedReason: locks.get(p.id) ?? null,
            undone: isUndone,
          };
        }),
        refunds: refunds.map((r) => ({
          id: r.id,
          amount: Number(r.amount),
          via: r.via as InvoiceRefundVia,
          paymentMethod: (r.payment?.methodType as PaymentRecordMethodValue | undefined) ?? null,
          method: (r.method as PaymentRecordMethodValue | null) ?? null,
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
          createdByName: r.createdBy?.fullName ?? null,
        })),
        communications: communications.map((c) => ({
          id: c.id,
          channel: c.channel,
          subject: c.subject,
          recipient: c.recipient,
          status: c.status,
          source: c.source,
          createdAt: c.createdAt.toISOString(),
          sentAt: c.sentAt?.toISOString() ?? null,
          errorMessage: c.errorMessage,
        })),
        dunning: dunning.map((d) => ({
          id: d.id,
          actionType: d.actionType,
          status: d.supersededAt ? 'superseded' : d.status,
          scheduledFor: d.scheduledFor.toISOString(),
          executedAt: d.executedAt?.toISOString() ?? null,
          notes: d.notes,
        })),
        history: history.map((h) => ({
          id: h.id,
          action: h.action,
          userName: h.user?.fullName ?? null,
          createdAt: h.occurredAt.toISOString(),
          changes:
            h.changes && typeof h.changes === 'object' && !Array.isArray(h.changes)
              ? (h.changes as Record<string, unknown>)
              : null,
        })),
      };
    }, tenantId);
  }

  // -------------------------------------------------------------------------
  // Deshacer o corregir un cobro registrado a mano
  // -------------------------------------------------------------------------

  async undoPayment(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    paymentId: string;
    reason: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const payment = await this.editablePayment(
      args.tenantId,
      args.invoiceId,
      args.paymentId,
      args.facilityScope,
    );
    await this.assertCashDayOpen(args.tenantId, args.invoiceId, payment.methodType, [
      payment.paidAt,
    ]);
    const dto = await this.invoices.revertPayment({
      tenantId: args.tenantId,
      userId: args.userId,
      invoiceId: args.invoiceId,
      amount: Number(payment.amount),
      reason: `Registrado por error: ${args.reason}`,
      paymentId: args.paymentId,
      undo: true,
      facilityScope: args.facilityScope ?? null,
      meta: args.meta,
    });
    this.refreshPdf(args.tenantId, args.invoiceId);
    return dto;
  }

  async correctPayment(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    paymentId: string;
    input: CorrectPaymentInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const payment = await this.editablePayment(
      args.tenantId,
      args.invoiceId,
      args.paymentId,
      args.facilityScope,
    );
    const paidAt = args.input.paidAt ? new Date(args.input.paidAt) : null;
    if (paidAt && paidAt.getTime() > Date.now() + 10 * 60_000) {
      throw new BadRequestException({
        code: 'paid_at_in_future',
        message: 'La fecha del cobro no puede ser futura',
      });
    }
    const nextMethod = args.input.methodType ?? payment.methodType;
    // Una caja cerrada no cambia: ni el día de antes ni el de ahora.
    if (payment.methodType === 'cash' || nextMethod === 'cash') {
      await this.assertCashDayOpen(args.tenantId, args.invoiceId, 'cash', [
        payment.paidAt,
        paidAt ?? payment.paidAt,
      ]);
    }
    await this.prisma.withTenant(async (tx) => {
      await tx.payment.update({
        where: { id: args.paymentId },
        data: {
          ...(paidAt ? { paidAt } : {}),
          ...(args.input.methodType ? { methodType: args.input.methodType } : {}),
        },
      });
      // Si la factura está pagada, su fecha de pago es la del último cobro.
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: args.invoiceId },
        select: { status: true },
      });
      if (invoice.status === 'paid' && paidAt) {
        const last = await tx.payment.findFirst({
          where: {
            invoiceId: args.invoiceId,
            status: 'succeeded',
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          orderBy: { paidAt: 'desc' },
          select: { paidAt: true },
        });
        if (last?.paidAt) {
          await tx.invoice.update({
            where: { id: args.invoiceId },
            data: { paidAt: last.paidAt },
          });
        }
      }
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.payment_corrected',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      changes: {
        paymentId: args.paymentId,
        from: { paidAt: payment.paidAt?.toISOString() ?? null, methodType: payment.methodType },
        to: {
          paidAt: (paidAt ?? payment.paidAt)?.toISOString() ?? null,
          methodType: nextMethod,
        },
        copiedToHolded: !!payment.holdedSyncedAt,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    this.refreshPdf(args.tenantId, args.invoiceId);
    return this.invoices.detail(args.tenantId, args.invoiceId, args.facilityScope);
  }

  /** Un cobro registrado a mano, sin devolver: el único que se corrige o deshace. */
  private async editablePayment(
    tenantId: string,
    invoiceId: string,
    paymentId: string,
    facilityScope?: string[] | null,
  ) {
    await this.invoices.detail(tenantId, invoiceId, facilityScope);
    const payment = await this.prisma.withTenant(
      (tx) => tx.payment.findFirst({ where: { id: paymentId, invoiceId } }),
      tenantId,
    );
    if (!payment) {
      throw new NotFoundException({ code: 'payment_not_found', message: 'Cobro no encontrado' });
    }
    if (!isEditable(payment)) {
      throw new BadRequestException({
        code: 'payment_not_editable',
        message:
          'Solo se corrige o deshace un cobro registrado a mano y sin devolver. Los de tarjeta o domiciliación se devuelven.',
      });
    }
    const lock = (
      await this.prisma.withTenant((tx) => paymentLocks(tx, [payment.id]), tenantId)
    ).get(payment.id);
    if (lock) {
      throw new BadRequestException({ code: 'payment_locked', message: lock });
    }
    return payment;
  }

  /** 409 si la caja de ese día (global o del local de la factura) ya se cerró. */
  private async assertCashDayOpen(
    tenantId: string,
    invoiceId: string,
    methodType: string,
    days: (Date | null)[],
  ): Promise<void> {
    if (methodType !== 'cash') return;
    const dates = [
      ...new Set(
        days
          .filter((d): d is Date => !!d)
          .map((d) => todayInTimezone('Europe/Madrid', d).getTime()),
      ),
    ].map((t) => new Date(t));
    if (dates.length === 0) return;
    const closed = await this.prisma.withTenant(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          facilityId: true,
          contract: { select: { unit: { select: { facilityId: true } } } },
        },
      });
      const facilityId = invoice?.contract?.unit?.facilityId ?? invoice?.facilityId ?? null;
      return tx.cashClosure.findFirst({
        where: {
          closureDate: { in: dates },
          OR: [{ facilityId: null }, ...(facilityId ? [{ facilityId }] : [])],
        },
        select: { closureDate: true },
      });
    }, tenantId);
    if (closed) {
      throw new ConflictException({
        code: 'cash_day_closed',
        message: `La caja del ${closed.closureDate.toISOString().slice(0, 10).split('-').reverse().join('/')} ya está cerrada: un cobro en efectivo de ese día no se puede cambiar.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Duplicar
  // -------------------------------------------------------------------------

  async duplicate(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const source = await this.invoices.detail(args.tenantId, args.invoiceId, args.facilityScope);
    if (source.kind !== 'invoice' || (source.invoiceType !== 'F1' && source.invoiceType !== 'F2')) {
      throw new BadRequestException({
        code: 'cannot_duplicate',
        message: 'Solo se duplican facturas completas o simplificadas',
      });
    }
    const justification = /^\[F2:([a-z_]+)\]/.exec(source.notes ?? '')?.[1];
    const notes = (source.notes ?? '').replace(/^\[F2:[a-z_]+\]\s*/, '').trim();
    const created = await this.invoices.create({
      tenantId: args.tenantId,
      userId: args.userId,
      facilityScope: args.facilityScope ?? null,
      meta: args.meta,
      input: {
        invoiceType: source.invoiceType,
        ...(source.customerId ? { customerId: source.customerId } : {}),
        ...(source.contractId ? { contractId: source.contractId } : {}),
        ...(source.invoiceType === 'F2' && justification
          ? { simplifiedJustification: justification as never }
          : {}),
        ...(notes ? { notes } : {}),
        items: source.items.map((it) => ({
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          taxRate: it.taxRate,
          taxCategory: it.taxCategory,
        })),
        verifactuMode: 'verifactu',
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.duplicated',
      entityType: 'Invoice',
      entityId: created.id,
      changes: { from: source.id, fromNumber: source.invoiceNumber },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return created;
  }

  // -------------------------------------------------------------------------
  // Anular: lo que va a pasar
  // -------------------------------------------------------------------------

  async cancelPreview(
    tenantId: string,
    invoiceId: string,
    facilityScope?: string[] | null,
  ): Promise<InvoiceCancelPreviewDto> {
    const dto = await this.invoices.detail(tenantId, invoiceId, facilityScope);
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: {
          consumedBenefits: true,
          customerId: true,
          lateFeeInvoice: {
            select: { id: true, invoiceNumber: true, total: true, status: true, amountPaid: true },
          },
        },
      });
      const benefits = (row.consumedBenefits ?? {}) as {
        freeMonth?: boolean;
        creditCents?: number;
      };
      const referral = await tx.referral.count({ where: { rewardInvoiceId: invoiceId } });
      const base = {
        freeMonth: !!benefits.freeMonth,
        credit: (benefits.creditCents ?? 0) / 100,
        referralReward: referral > 0,
        periodic: !!dto.periodStart && !!dto.contractId,
        lateFee: null,
        accessRestored: false,
        creditNoteTotal: null,
        blockedReason: null,
      } satisfies Partial<InvoiceCancelPreviewDto>;
      if (dto.status === 'draft') return { ...base, action: 'cancel_draft' as const };
      const blocked = (reason: string): InvoiceCancelPreviewDto => ({
        ...base,
        action: 'blocked',
        blockedReason: reason,
      });
      if (dto.kind !== 'invoice' || !['F1', 'F2'].includes(dto.invoiceType)) {
        return blocked('Esta factura no se anula: rectifícala.');
      }
      if (dto.status !== 'issued' && dto.status !== 'overdue') {
        return blocked('Solo se anula una factura emitida o vencida sin cobros.');
      }
      const realPayments = await tx.payment.count({
        where: {
          invoiceId,
          status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
        },
      });
      if (realPayments > 0) {
        return blocked(
          'Tiene cobros: devuélvelos antes o rectifícala para dejar solo lo que corresponda.',
        );
      }
      if (await hasPaymentInFlight(tx, invoiceId)) {
        return blocked('Tiene un cobro en curso o está en una remesa SEPA sin confirmar.');
      }
      const fee = row.lateFeeInvoice;
      const feeVoided =
        fee && (fee.status === 'issued' || fee.status === 'overdue') && Number(fee.amountPaid) === 0
          ? { id: fee.id, invoiceNumber: fee.invoiceNumber, total: Number(fee.total) }
          : null;
      // ¿Le devuelve el acceso? Si esta factura lo cortó y no debe otra cortada.
      let accessRestored = false;
      if (row.customerId) {
        const cuts = await tx.dunningAction.findMany({
          where: {
            ...ACCESS_CUT_APPLIED_WHERE,
            invoice: {
              customerId: row.customerId,
              status: { in: ['issued', 'overdue'] },
              deletedAt: null,
            },
          },
          select: { invoiceId: true },
        });
        const ids = new Set(cuts.map((c) => c.invoiceId));
        accessRestored = ids.has(invoiceId) && ids.size === 1;
      }
      return {
        ...base,
        action: 'void' as const,
        creditNoteTotal: -dto.total,
        lateFee: feeVoided,
        accessRestored,
      };
    }, tenantId);
  }

  // -------------------------------------------------------------------------
  // Devoluciones: cómo vuelve el dinero
  // -------------------------------------------------------------------------

  async refundOptions(
    tenantId: string,
    invoiceId: string,
    facilityScope?: string[] | null,
  ): Promise<InvoiceRefundOptionsDto> {
    const dto = await this.invoices.detail(tenantId, invoiceId, facilityScope);
    return this.prisma.withTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: {
          invoiceId,
          status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
        },
        orderBy: { createdAt: 'desc' },
        include: { paymentMethod: { select: { last4: true } } },
      });
      const collected = payments.reduce((sum, p) => sum + toCents(p.amount), 0);
      const refundable = Math.max(0, collected - toCents(dto.amountRefunded)) / 100;
      const live = payments.find(
        (p) => p.status === 'succeeded' || p.status === 'partially_refunded',
      );
      const gateway = payments.find(
        (p) =>
          p.gatewayPaymentId && (p.status === 'succeeded' || p.status === 'partially_refunded'),
      );
      const how: InvoiceRefundOptionsDto['how'] = gateway
        ? gateway.gateway === 'stripe' || gateway.gateway === 'gocardless'
          ? 'gateway'
          : 'bank'
        : live
          ? 'manual'
          : 'none';
      const pick = gateway ?? live ?? null;
      return {
        refundable,
        how,
        methodType: (pick?.methodType as PaymentRecordMethodValue | undefined) ?? null,
        last4: pick?.paymentMethod?.last4 ?? null,
        creditAvailable: !!dto.contractId,
      };
    }, tenantId);
  }

  // -------------------------------------------------------------------------
  // Enviar la factura por correo
  // -------------------------------------------------------------------------

  async sendEmail(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    input: SendInvoiceEmailInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<SendInvoiceEmailResultDto> {
    const dto = await this.invoices.detail(args.tenantId, args.invoiceId, args.facilityScope);
    if (dto.status === 'draft' || dto.status === 'cancelled') {
      throw new BadRequestException({
        code: 'invoice_not_sendable',
        message: 'Un borrador no se envía: emítelo primero',
      });
    }
    const sent = await this.customerEmails.sendInvoiceCopy({
      tenantId: args.tenantId,
      invoiceId: args.invoiceId,
      ...(args.input.email ? { email: args.input.email } : {}),
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.sent',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      changes: { recipient: sent.recipient },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    // Sin PDF aún (o con el de antes): el enlace lo genera al abrirse.
    if (!dto.hasPdf) this.refreshPdf(args.tenantId, args.invoiceId, false);
    return sent;
  }

  // -------------------------------------------------------------------------
  // Cierre del mes
  // -------------------------------------------------------------------------

  async monthClose(
    tenantId: string,
    month: string,
    facilityScope?: string[] | null,
  ): Promise<MonthCloseDto> {
    const { start, end } = monthRange(month);
    return this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          timezone: true,
          taxId: true,
          billingLegalName: true,
          billingAddress: true,
          billingPostalCode: true,
          billingCity: true,
        },
      });
      const today = todayInTimezone(tenant.timezone);
      const ofMonth: Prisma.InvoiceWhereInput = {
        deletedAt: null,
        kind: 'invoice',
        OR: [
          { periodStart: { gte: start, lte: end } },
          { periodStart: null, createdAt: { gte: start, lt: addDays(end, 1) } },
        ],
      };
      const scope: Prisma.InvoiceWhereInput = facilityScope
        ? {
            OR: [
              { contractId: null },
              { contract: { unit: { facilityId: { in: facilityScope } } } },
            ],
          }
        : {};
      const invoices = await tx.invoice.findMany({
        where: { AND: [ofMonth, scope], status: { in: ['draft', 'issued', 'overdue', 'paid'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 2000,
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          total: true,
          amountPaid: true,
          customerId: true,
          contract: {
            select: {
              status: true,
              endDate: true,
              unit: { select: { code: true, facility: { select: { name: true } } } },
            },
          },
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
              email: true,
              billingEmail: true,
              documentNumber: true,
            },
          },
        },
      });
      const customerIds = [
        ...new Set(invoices.map((i) => i.customerId).filter((c): c is string => !!c)),
      ];
      const [methods, mandates, debts] = await Promise.all([
        tx.paymentMethod.findMany({
          where: {
            customerId: { in: customerIds },
            deletedAt: null,
            type: { in: ['card', 'sepa_debit'] },
          },
          select: { customerId: true },
        }),
        tx.sepaMandate.findMany({
          where: { customerId: { in: customerIds }, ...CHARGEABLE_MANDATE_WHERE },
          select: { customerId: true },
        }),
        tx.invoice.findMany({
          where: { customerId: { in: customerIds }, ...overdueInvoiceWhere(today) },
          select: { id: true, customerId: true },
        }),
      ]);
      const chargeable = new Set([
        ...methods.map((m) => m.customerId),
        ...mandates.map((m) => m.customerId),
      ]);
      const toRow = (i: (typeof invoices)[number]): MonthCloseRowDto => {
        const warnings: MonthCloseWarning[] = [];
        const c = i.customer;
        if (c && !c.email && !c.billingEmail) warnings.push('no_email');
        if (i.customerId && !chargeable.has(i.customerId)) warnings.push('no_payment_method');
        if (toCents(i.total) === 0) warnings.push('zero_total');
        if (
          i.contract &&
          (i.contract.status === 'ending' ||
            (i.contract.endDate && i.contract.endDate >= start && i.contract.endDate <= end))
        ) {
          warnings.push('contract_ending');
        }
        if (c?.customerType === 'business' && !c.documentNumber) warnings.push('no_tax_id');
        if (debts.some((d) => d.customerId === i.customerId && d.id !== i.id)) {
          warnings.push('previous_debt');
        }
        return {
          invoiceId: i.id,
          invoiceNumber: i.invoiceNumber.startsWith('DRAFT-') ? null : i.invoiceNumber,
          status: i.status as MonthCloseRowDto['status'],
          customerId: i.customerId,
          customerName: c
            ? c.customerType === 'business'
              ? (c.companyName ?? 'Empresa')
              : [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Sin nombre'
            : null,
          unitCode: i.contract?.unit?.code ?? null,
          facilityName: i.contract?.unit?.facility?.name ?? null,
          total: Number(i.total),
          amountPending:
            i.status === 'issued' || i.status === 'overdue'
              ? Math.max(0, toCents(i.total) - toCents(i.amountPaid)) / 100
              : 0,
          chargeable: !!i.customerId && chargeable.has(i.customerId),
          warnings,
        };
      };
      // Contratos vivos sin factura que toque este mes (la recurrente los generaría).
      const missingContracts = await tx.contract.count({
        where: {
          deletedAt: null,
          status: { in: ['active', 'ending'] },
          signedAt: { not: null },
          startDate: { lte: end },
          OR: [{ endDate: null }, { endDate: { gte: start } }],
          AND: [
            { OR: [{ billingStartsOn: null }, { billingStartsOn: { lte: end } }] },
            ...(facilityScope ? [{ unit: { facilityId: { in: facilityScope } } }] : []),
          ],
          invoices: {
            none: {
              deletedAt: null,
              kind: 'invoice',
              periodStart: { lte: end },
              periodEnd: { gte: start },
            },
          },
        },
      });
      return {
        month,
        missingContracts,
        drafts: invoices.filter((i) => i.status === 'draft').map(toRow),
        pending: invoices
          .filter((i) => i.status === 'issued' || i.status === 'overdue')
          .map(toRow)
          .filter((r) => r.amountPending > 0),
        paidCount: invoices.filter((i) => i.status === 'paid').length,
        issuerMissing: tenantFiscalDataMissing(tenant),
      };
    }, tenantId);
  }

  async generateMonth(
    tenantId: string,
    userId: string,
    month: string,
    meta: RequestMeta,
  ): Promise<MonthCloseGenerateResultDto> {
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } }),
      tenantId,
    );
    const current = todayInTimezone(tenant.timezone).toISOString().slice(0, 7);
    if (month > current) {
      throw new BadRequestException({
        code: 'month_in_future',
        message: 'Las cuotas de un mes se generan cuando empieza',
      });
    }
    const { start, end } = monthRange(month);
    const result = await this.billingJobs.processGenerateRecurring({
      tenantId,
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
    });
    await this.audit.write({
      tenantId,
      userId,
      action: 'invoice.month_generated',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { month, created: result.created },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { created: result.created };
  }

  // -------------------------------------------------------------------------
  // Vistas guardadas de la lista
  // -------------------------------------------------------------------------

  async listViews(tenantId: string): Promise<InvoiceSavedViewDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.invoiceSavedView.findMany({
          orderBy: { name: 'asc' },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map(toViewDto);
  }

  /** Guardar con un nombre que ya existe la sustituye. */
  async saveView(
    tenantId: string,
    userId: string,
    input: SaveInvoiceViewInput,
  ): Promise<InvoiceSavedViewDto> {
    const filters = input.filters as Prisma.InputJsonValue;
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.invoiceSavedView.upsert({
          where: { tenantId_name: { tenantId, name: input.name } },
          create: { tenantId, name: input.name, filters, createdByUserId: userId },
          update: { filters },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return toViewDto(row);
  }

  async deleteView(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) => tx.invoiceSavedView.deleteMany({ where: { id } }),
      tenantId,
    );
  }

  /** Vuelve a generar el PDF (sello de pagada, fecha de cobro…). */
  private refreshPdf(tenantId: string, invoiceId: string, refresh = true): void {
    this.events.emit(INVOICE_PDF_REQUESTED, {
      tenantId,
      invoiceId,
      refresh,
    } satisfies InvoicePdfRequestedPayload);
  }
}

function emptyCollection(): InvoiceCollectionDto {
  return { inFlight: false, inRemittance: false, inPaymentPlan: false, lastReminderAt: null };
}

function isEditable(p: {
  gateway: string;
  methodType: string;
  status: string;
  refundedAmount: Prisma.Decimal | number;
}): boolean {
  return (
    p.gateway === MANUAL_MONEY.gateway &&
    !(NON_CASH_PAYMENT_METHODS as readonly string[]).includes(p.methodType) &&
    // La fianza aplicada se corrige desde la fianza del contrato.
    p.methodType !== 'deposit' &&
    p.status === 'succeeded' &&
    Number(p.refundedAmount) === 0
  );
}

/**
 * Cobros que se gestionan desde otra pantalla y no se corrigen ni deshacen en
 * la factura (se quedaría desconectado de su origen): los de una remesa SEPA
 * (se marcan devueltos en la remesa) y los de la conciliación bancaria (se
 * deshacen en el extracto).
 */
async function paymentLocks(
  tx: Prisma.TransactionClient,
  paymentIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paymentIds.length === 0) return out;
  const [items, bank] = await Promise.all([
    tx.sepaRemittanceItem.findMany({
      where: { paymentId: { in: paymentIds } },
      select: { paymentId: true, remittance: { select: { name: true } } },
    }),
    tx.bankStatementTransaction.findMany({
      where: {
        OR: [
          { matchedPaymentIds: { hasSome: paymentIds } },
          { matchedPaymentId: { in: paymentIds } },
        ],
      },
      select: { matchedPaymentIds: true, matchedPaymentId: true },
    }),
  ]);
  for (const i of items) {
    if (!i.paymentId) continue;
    out.set(
      i.paymentId,
      `Viene de la remesa SEPA «${i.remittance.name}»: si el banco lo devolvió, márcalo como devuelto en la remesa.`,
    );
  }
  for (const b of bank) {
    for (const id of [
      ...b.matchedPaymentIds,
      ...(b.matchedPaymentId ? [b.matchedPaymentId] : []),
    ]) {
      if (!paymentIds.includes(id) || out.has(id)) continue;
      out.set(
        id,
        'Viene de la conciliación bancaria: deshazlo desde el extracto en Conciliación bancaria.',
      );
    }
  }
  return out;
}

/** `2026-11` → 1 y 30 de noviembre (fechas UTC a medianoche, como las columnas DATE). */
function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(y!, m!, 0));
  return { start, end };
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function toViewDto(r: {
  id: string;
  name: string;
  filters: Prisma.JsonValue;
  createdBy: { fullName: string } | null;
}): InvoiceSavedViewDto {
  return {
    id: r.id,
    name: r.name,
    filters: (r.filters ?? {}) as Record<string, unknown>,
    createdByName: r.createdBy?.fullName ?? null,
  };
}
