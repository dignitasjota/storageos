import { randomUUID } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import {
  defaultTaxCategory,
  isValidSpanishTaxId,
  normalizeTaxId,
  taxCategoryAllowsRate,
  type InvoiceTaxCategory,
  NON_CASH_PAYMENT_METHODS,
} from '@storageos/shared';

import { customerScopeWhere } from '../../common/customer-scope';
import { assertFacilityAllowed, invoiceFacilityWhere } from '../../common/facility-scope';
import { emailLocale, formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import {
  addAmounts,
  isAtLeast,
  isGreaterThan,
  lineCents,
  subtractAmounts,
  toCents,
} from '../../common/money';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { isUniqueViolation } from '../../common/prisma-errors';
import {
  assertNotInSepaRemittance,
  CHARGEABLE_MANDATE_WHERE,
  hasPaymentInFlight,
} from '../../common/sepa-remittance-guard';
import { tenantFiscalDataMissing } from '../../common/tenant-readiness';
import { HoldedSettingsService } from '../accounting/holded-settings.service';
import { HoldedSyncService } from '../accounting/holded-sync.service';
import { AuditService } from '../auth/audit.service';
import {
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type InvoiceCancelledPayload,
  type InvoicePaymentRevertedPayload,
  type InvoiceRefundedPayload,
  type InvoiceVoidedPayload,
} from '../automations/domain-events';
import { CommunicationsService } from '../communications/communications.service';
import { overdueInvoiceWhere } from '../dashboard/today-filters';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { GoCardlessChargeService } from '../payments/gocardless/gocardless-charge.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payments/payment-gateway.interface';

import { InvoiceSeriesService } from './invoice-series.service';
import { InvoicingModeService } from './invoicing-mode.service';
import { buildReminderSummary, remindersOfInvoice } from './reminder-summary';
import { VerifactuDispatcher } from './verifactu-dispatcher.service';
import { VerifactuRecordsService } from './verifactu-records.service';
import { VerifactuService } from './verifactu.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Invoice, InvoiceItem, InvoiceStatus, InvoiceType } from '@storageos/database';
import type {
  BulkInvoiceActionResultDto,
  CancelInvoiceInput,
  LateFeePreviewDto,
  CorrectionMethodValue,
  CreateInvoiceInput,
  CreateInvoiceItemInput,
  InvoiceDto,
  InvoiceItemDto,
  InvoicePaymentFilterValue,
  InvoiceSortValue,
  InvoiceStatusValue,
  InvoiceTotalsDto,
  InvoiceTypeFilterValue,
  InvoiceTypeValue,
  MarkPaidManuallyInput,
  RectifyInvoiceInput,
  RectifyInvoiceItemInput,
  RefundInvoiceInput,
  SignedDownloadDto,
  UpdateInvoiceInput,
  VerifactuRecordDto,
  VoidInvoiceInput,
} from '@storageos/shared';

/** Tipo fiscal de la línea: el indicado (validado) o el de por defecto según el tipo. */
function lineTaxCategory(taxRate: number, category?: InvoiceTaxCategory): InvoiceTaxCategory {
  const c = category ?? defaultTaxCategory(taxRate);
  if (!taxCategoryAllowsRate(c, taxRate)) {
    throw new BadRequestException({
      code: 'exempt_line_with_vat',
      message: 'Una línea exenta o no sujeta va al 0 % de IVA',
    });
  }
  return c;
}

/** El mensaje que dejó la AEAT en la respuesta del último registro (sin el del modo de pruebas). */
function aeatResponseMessage(response: Prisma.JsonValue | null): string | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const { message, mode } = response as Record<string, unknown>;
  if (mode === 'stub' || typeof message !== 'string' || !message.trim()) return null;
  return message.trim();
}

const ALLOWED_TRANSITIONS: Record<InvoiceStatusValue, InvoiceStatusValue[]> = {
  draft: ['issued', 'cancelled'],
  // Emitida: no se «cancela»; se anula con rectificativa (`rectified`).
  issued: ['paid', 'overdue', 'rectified', 'refunded', 'partially_refunded'],
  overdue: ['paid', 'rectified', 'refunded', 'partially_refunded'],
  paid: ['refunded', 'partially_refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
  cancelled: [],
  rectified: [],
};

type InvoiceWithRelations = Invoice & {
  items: InvoiceItem[];
  owner?: { legalName: string } | null;
  // Nullable desde Fase 13A.3 (F2 sin destinatario identificado).
  customer: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: 'individual' | 'business';
  } | null;
  contract: {
    contractNumber: string;
    offlinePaymentMethod: string | null;
    unit: { id: string; code: string; facility: { id: string; name: string } } | null;
  } | null;
  series: { code: string };
  rectifiesInvoice: { id: string; invoiceNumber: string; issueDate: Date | null } | null;
  /** Solo las compensaciones con un abono (`credit_note`). */
  payments: { amount: Prisma.Decimal }[];
  rectifiedBy: { id: string; invoiceNumber: string; status: string; total: Prisma.Decimal }[];
  lateFeeInvoice: { id: string } | null;
};

export interface ListFilters {
  status?: InvoiceStatusValue;
  customerId?: string;
  contractId?: string;
  overdue?: boolean;
  /** Locales a los que el usuario está restringido; null/undefined = todos. */
  facilityScope?: string[] | null;
  /** Local elegido en el selector de la cabecera. */
  facilityId?: string;
  /** Nº de factura o inquilino. */
  search?: string;
  /** Fecha de emisión desde / hasta (AAAA-MM-DD, incluidas). */
  from?: string;
  to?: string;
  type?: InvoiceTypeFilterValue;
  payment?: InvoicePaymentFilterValue;
  sort?: InvoiceSortValue;
  page?: PageRequest;
}

/** Orden de la lista (todos terminan en `id`: el cursor necesita un orden estable). */
const LIST_ORDER: Record<InvoiceSortValue, Prisma.InvoiceOrderByWithRelationInput[]> = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  oldest: [{ createdAt: 'asc' }, { id: 'asc' }],
  due: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  amount: [{ total: 'desc' }, { id: 'desc' }],
};

/** Motivo de las rectificativas automáticas por reembolso. */
const REFUND_CREDIT_REASON = 'Reembolso de lo cobrado';

/**
 * Lo que gasta una factura al crearse: si se cancela o se anula, vuelve al
 * contrato (si no, el inquilino perdía su mes gratis o su señal).
 */
export interface ConsumedBenefits {
  /** Un mes gratis de una promoción. */
  freeMonth?: boolean;
  /** Saldo a favor del contrato (la señal de la reserva) descontado. */
  creditCents?: number;
  creditReason?: string | null;
}

/** Dos registros iguales en este margen son un doble clic, no dos cobros. */
const DUPLICATE_WINDOW_MS = 30_000;

/** Un recordatorio por factura y día como mucho. */
const REMINDER_GAP_MS = 24 * 60 * 60 * 1000;

/** Total máximo de una factura (por encima, el importe es un error). */
const MAX_INVOICE_TOTAL_CENTS = 99_999_999_900;

/** Pide el PDF de una factura (lo genera el worker). */
export const INVOICE_PDF_REQUESTED = 'billing.invoice_pdf_requested';
export interface InvoicePdfRequestedPayload {
  tenantId: string;
  invoiceId: string;
  /** Rehacerlo aunque ya exista (se ha pagado, devuelto, corregido…). */
  refresh?: boolean;
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly series: InvoiceSeriesService,
    private readonly verifactu: VerifactuService,
    private readonly events: EventEmitter2,
    private readonly verifactuDispatcher: VerifactuDispatcher,
    private readonly verifactuRecords: VerifactuRecordsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly communications: CommunicationsService,
    private readonly goCardlessCharge: GoCardlessChargeService,
    private readonly files: FilesService,
    private readonly invoicingMode: InvoicingModeService,
    private readonly holdedSettings: HoldedSettingsService,
    private readonly holdedSync: HoldedSyncService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<InvoiceDto[]> {
    const rows = await this.prisma.withTenant(async (tx) => {
      const where = await this.listWhere(tx, filters);
      if (!where) return [];
      return tx.invoice.findMany({
        where,
        // Por fecha de alta: generar el PDF o cobrar no la mueve en la lista.
        orderBy: LIST_ORDER[filters.sort ?? 'newest'],
        ...pageArgs(filters.page),
        include: this.includeRelations(),
      });
    }, tenantId);
    return rows.map((r) => this.toDto(r));
  }

  /** Lo que suman las facturas de la lista con esos filtros (sin las canceladas). */
  async totals(tenantId: string, filters: ListFilters): Promise<InvoiceTotalsDto> {
    return this.prisma.withTenant(async (tx) => {
      const where = await this.listWhere(tx, filters);
      if (!where) return { count: 0, total: 0, pending: 0, collected: 0 };
      const [count, all, open, paid] = await Promise.all([
        tx.invoice.count({ where }),
        tx.invoice.aggregate({
          where: { AND: [where, { status: { not: 'cancelled' } }] },
          _sum: { total: true },
        }),
        tx.invoice.aggregate({
          where: { AND: [where, { status: { in: ['issued', 'overdue'] } }] },
          _sum: { total: true, amountPaid: true },
        }),
        tx.payment.aggregate({
          where: {
            invoice: where,
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          _sum: { amount: true, refundedAmount: true },
        }),
      ]);
      return {
        count,
        total: Number(all._sum.total ?? 0),
        pending: subtractAmounts(open._sum.total ?? 0, open._sum.amountPaid ?? 0),
        collected: subtractAmounts(paid._sum.amount ?? 0, paid._sum.refundedAmount ?? 0),
      };
    }, tenantId);
  }

  /** Filtros de la lista. null = el usuario no ve ningún local de los pedidos. */
  private async listWhere(
    tx: Prisma.TransactionClient,
    filters: ListFilters,
  ): Promise<Prisma.InvoiceWhereInput | null> {
    const and: Prisma.InvoiceWhereInput[] = [{ deletedAt: null }];
    if (filters.status) and.push({ status: filters.status as InvoiceStatus });
    if (filters.customerId) and.push({ customerId: filters.customerId });
    if (filters.contractId) and.push({ contractId: filters.contractId });
    // Alcance por local: un usuario restringido solo ve las facturas de contratos
    // de sus locales. Las facturas SIN contrato (F2/ventas de producto) no están
    // ancladas a un local → se incluyen (no son "la caja" de un local ajeno).
    const facility = invoiceFacilityWhere(filters.facilityScope, filters.facilityId);
    if (!facility) return null;
    and.push(facility as Prisma.InvoiceWhereInput);
    // Por palabras: «Ana García» encuentra a quien se llama Ana y se apellida García.
    const words = (filters.search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
    for (const word of words) {
      const q = { contains: word, mode: 'insensitive' as const };
      and.push({
        OR: [
          { invoiceNumber: q },
          { customer: { firstName: q } },
          { customer: { lastName: q } },
          { customer: { companyName: q } },
        ],
      });
    }
    if (filters.overdue) {
      // «Solo vencidas» se suma al estado elegido (antes lo pisaba).
      const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
      and.push(overdueInvoiceWhere(todayInTimezone(tenant?.timezone ?? 'Europe/Madrid')));
    }
    if (filters.from) and.push({ issueDate: { gte: new Date(`${filters.from}T00:00:00Z`) } });
    if (filters.to) and.push({ issueDate: { lte: new Date(`${filters.to}T00:00:00Z`) } });
    if (filters.type === 'deposit') and.push({ kind: 'deposit_receipt' });
    else if (filters.type === 'R') {
      and.push({ kind: 'invoice', invoiceType: { in: ['R1', 'R2', 'R3', 'R4', 'R5'] } });
    } else if (filters.type) and.push({ kind: 'invoice', invoiceType: filters.type });
    if (filters.payment === 'none') {
      // Pendiente y sin forma de pago guardada: habrá que cobrarla a mano.
      and.push({
        status: { in: ['issued', 'overdue'] },
        customer: {
          paymentMethods: { none: { deletedAt: null, type: { in: ['card', 'sepa_debit'] } } },
          sepaMandates: { none: CHARGEABLE_MANDATE_WHERE },
        },
      });
    } else if (filters.payment) {
      and.push({
        payments: {
          some: {
            methodType: filters.payment,
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
          },
        },
      });
    }
    return { AND: and };
  }

  async detail(tenantId: string, id: string, facilityScope?: string[] | null): Promise<InvoiceDto> {
    return this.toDto(await this.findOrThrow(tenantId, id, facilityScope));
  }

  /**
   * URL firmada de corta duración para descargar el PDF (staff). El
   * `pdf_url` guardado es una URL PERMANENTE sin firmar sobre un bucket
   * privado (`invoices`) — nunca se expone tal cual; se firma bajo demanda.
   */
  async getSignedPdfUrl(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<SignedDownloadDto> {
    const row = await this.findOrThrow(tenantId, id, facilityScope);
    const url = row.pdfUrl
      ? await this.files.presignFromPublicUrl('invoices', row.pdfUrl, 300)
      : null;
    if (!url) {
      throw new NotFoundException({
        code: 'pdf_not_available',
        message: 'Aún no hay un PDF generado',
      });
    }
    return { url };
  }

  async create(args: {
    tenantId: string;
    userId: string | null;
    input: CreateInvoiceInput;
    meta: RequestMeta;
    /**
     * Emisor (plan Administrador). Sin indicar, el del contrato (si lo hay).
     * Uso interno: el recargo por mora lo emite el emisor de la vencida.
     */
    ownerId?: string | null;
    /** Alcance por local de quien la crea desde el panel. */
    facilityScope?: string[] | null;
    /** Uso interno: lo que gasta (mes gratis, señal), para devolverlo si se cancela. */
    consumedBenefits?: ConsumedBenefits;
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
      this.assertSimplifiedLimit(total, args.input.simplifiedJustification !== undefined);
    }

    const created = await this.prisma
      .withTenant(async (tx) => {
        if (args.input.customerId) {
          const customer = await tx.customer.findFirst({
            where: {
              id: args.input.customerId,
              deletedAt: null,
              // Quien solo ve unos locales no factura a inquilinos de otros.
              ...customerScopeWhere(args.facilityScope ?? null),
            },
          });
          if (!customer) {
            throw new NotFoundException({
              code: 'customer_not_found',
              message: 'Inquilino no encontrado',
            });
          }
        }
        // Emisor: el propietario del contrato (plan Administrador) o el tenant.
        let ownerId: string | null = args.ownerId ?? null;
        if (args.input.contractId) {
          const contract = await tx.contract.findFirst({
            where: { id: args.input.contractId, deletedAt: null },
            select: { ownerId: true, customerId: true, unit: { select: { facilityId: true } } },
          });
          if (!contract) {
            throw new NotFoundException({
              code: 'contract_not_found',
              message: 'Contrato no encontrado',
            });
          }
          if (args.input.customerId && contract.customerId !== args.input.customerId) {
            throw new BadRequestException({
              code: 'contract_customer_mismatch',
              message: 'Ese contrato es de otro inquilino',
            });
          }
          if (args.facilityScope)
            assertFacilityAllowed(args.facilityScope, contract.unit.facilityId);
          if (args.ownerId === undefined) ownerId = contract.ownerId;
        }
        let series = args.input.seriesId
          ? await tx.invoiceSeries.findUniqueOrThrow({ where: { id: args.input.seriesId } })
          : ownerId
            ? await this.series.ownerSeries(tx, args.tenantId, ownerId)
            : await tx.invoiceSeries.findFirst({
                where: { isDefault: true, isActive: true, ownerId: null },
              });
        // Los procesos automáticos (recurrente, reserva online…) pasan la
        // serie por defecto del tenant: para un propietario va a la suya.
        if (ownerId && series && series.ownerId === null && series.isDefault) {
          series = await this.series.ownerSeries(tx, args.tenantId, ownerId);
        }
        if (series && series.ownerId !== ownerId) {
          throw new BadRequestException({
            code: 'series_owner_mismatch',
            message: ownerId
              ? 'Esta factura la emite el propietario del contrato: usa su serie'
              : 'Esa serie es de un propietario; elige una serie de tu empresa',
          });
        }
        if (!series) {
          throw new BadRequestException({
            code: 'no_default_series',
            message: 'No hay serie por defecto configurada',
          });
        }
        // En draft NO se asigna invoiceNumber; se asigna al issue.
        const placeholderNumber = draftPlaceholderNumber();
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
            ...(ownerId ? { ownerId } : {}),
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
            ...(args.consumedBenefits
              ? { consumedBenefits: args.consumedBenefits as Prisma.InputJsonValue }
              : {}),
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
    facilityScope?: string[] | null;
    input: UpdateInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    if (existing.status !== 'draft' && args.input.items !== undefined) {
      throw new BadRequestException({
        code: 'invoice_not_editable',
        message: 'Las líneas solo se cambian en un borrador',
      });
    }
    // Una simplificada editada sigue dentro de su límite (el motivo va en las notas).
    if (args.input.items !== undefined && existing.invoiceType === 'F2') {
      this.assertSimplifiedLimit(
        this.computeTotals(args.input.items).total,
        (existing.notes ?? '').startsWith('[F2:'),
      );
    }
    // Vencimiento de una factura ya emitida: solo si se está cobrando, y con
    // motivo (queda en el registro de actividad).
    const dueChange = existing.status !== 'draft' && args.input.dueDate !== undefined;
    if (dueChange) {
      if (existing.status !== 'issued' && existing.status !== 'overdue') {
        throw new BadRequestException({
          code: 'invoice_not_editable',
          message: 'Solo se cambia el vencimiento de una factura pendiente de pago',
        });
      }
      if (!args.input.dueDate) {
        throw new BadRequestException({
          code: 'due_date_required',
          message: 'Indica la nueva fecha de vencimiento',
        });
      }
      if (!args.input.dueDateReason?.trim()) {
        throw new BadRequestException({
          code: 'due_date_reason_required',
          message: 'Indica por qué cambia el vencimiento',
        });
      }
      if (existing.issueDate && args.input.dueDate < ymd(existing.issueDate)) {
        throw new BadRequestException({
          code: 'due_date_before_issue',
          message: 'El vencimiento no puede ser anterior a la fecha de emisión',
        });
      }
    }
    const updated = await this.prisma.withTenant(async (tx) => {
      const data: Prisma.InvoiceUpdateInput = {};
      if (args.input.dueDate !== undefined) {
        data.dueDate = args.input.dueDate ? new Date(args.input.dueDate) : null;
      }
      if (dueChange && existing.status === 'overdue') {
        const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
        const today = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
        // Aplazada a una fecha que aún no ha llegado: deja de estar vencida y
        // los avisos que quedaban por mandar se cancelan (si vuelve a vencer,
        // el escalado empieza desde la fecha nueva).
        if (new Date(args.input.dueDate as string) >= today) {
          data.status = 'issued';
          await tx.dunningAction.updateMany({
            where: { invoiceId: args.invoiceId, status: 'scheduled', supersededAt: null },
            data: { status: 'cancelled', notes: 'Vencimiento aplazado' },
          });
        }
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
      action: dueChange ? 'invoice.due_date_changed' : 'invoice.updated',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      ...(dueChange
        ? {
            changes: {
              from: existing.dueDate ? ymd(existing.dueDate) : null,
              to: args.input.dueDate ?? null,
              reason: args.input.dueDateReason?.trim() ?? null,
            },
          }
        : {}),
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /** Factura simplificada: hasta 400 €, o hasta 3.000 € con un motivo (RD 1619/2012). */
  private assertSimplifiedLimit(total: number, justified: boolean): void {
    const limit = justified ? 3000 : 400;
    if (!isGreaterThan(total, limit)) return;
    throw new BadRequestException({
      code: 'f2_amount_limit_exceeded',
      message: justified
        ? `El total ${total.toFixed(2)} € supera el límite de una factura simplificada con motivo (3.000 €)`
        : `El total ${total.toFixed(2)} € supera el límite de una factura simplificada (400 €). Indica un motivo para llegar a 3.000 €.`,
    });
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
    facilityScope?: string[] | null;
    meta: RequestMeta;
    /** Rectificativa ya creada por el tenant en Holded (modo Holded): se enlaza. */
    holdedDocument?: { documentId: string; number: string };
    /**
     * Una factura de 0 € queda saldada al emitirse. La primera factura de un
     * contrato lo hace ella misma después de crear el justificante de fianza
     * (el acceso espera a que se pague la fianza).
     */
    settleZero?: boolean;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    if (existing.kind === 'deposit_receipt') {
      throw new BadRequestException({
        code: 'invoice_already_issued',
        message: 'Un justificante de fianza no se emite: ya está disponible para cobrar',
      });
    }
    this.assertTransition(existing.status as InvoiceStatusValue, 'issued');

    // Modo Holded: Holded numera la factura y la registra en Veri*Factu. Se
    // emite allí primero (fuera de la transacción: es una llamada externa) y
    // luego se guarda aquí con su número.
    // Las facturas de un propietario (plan Administrador) se emiten siempre
    // aquí: la cuenta de Holded es la del tenant (otro NIF).
    const mode = existing.ownerId
      ? 'app'
      : await this.prisma.withTenant(
          (tx) => this.invoicingMode.current(tx, args.tenantId),
          args.tenantId,
        );
    if (mode === 'holded' && existing.rectifiesInvoiceId && !args.holdedDocument) {
      // La API de Holded no permite indicar qué factura rectifica: la
      // rectificativa la hace el tenant en Holded desde la original y luego se
      // enlaza aquí (`linkHoldedCreditNote`). Hasta entonces queda pendiente.
      return this.awaitHoldedCreditNote(args.tenantId, existing);
    }
    const fromHolded =
      mode === 'holded'
        ? (args.holdedDocument ?? (await this.issueInHolded(args.tenantId, existing)))
        : null;

    let compensatedOriginal: {
      id: string;
      invoiceNumber: string;
      customerId: string | null;
      total: number;
      fullyPaid: boolean;
    } | null = null;
    // A 0 € no hay nada que cobrar: queda saldada (sin correo de «nueva factura»).
    const settledZero = toCents(Number(existing.total)) === 0 && args.settleZero !== false;
    const updated = await this.prisma.withTenant(async (tx) => {
      // Dos «Emitir» a la vez (doble clic, lote + emisión automática): la fila
      // bloqueada serializa y el segundo ve la factura ya emitida → 409, en vez
      // de reservar otro número (hueco en la serie) y enviarla dos veces a la AEAT.
      await lockInvoiceRow(tx, args.invoiceId);
      const fresh = await tx.invoice.findUnique({
        where: { id: args.invoiceId },
        select: { status: true },
      });
      if (fresh?.status !== 'draft') {
        throw new ConflictException({
          code: 'invoice_already_issued',
          message: 'La factura ya se ha emitido',
        });
      }
      if (existing.rectifiesInvoiceId) {
        const method = (existing.correctionMethod ?? 'by_differences') as CorrectionMethodValue;
        await this.assertRectificationLimits(tx, {
          originalId: existing.rectifiesInvoiceId,
          selfId: existing.id,
          total: Number(existing.total),
          method,
        });
        if (method === 'by_substitution') {
          // La sustituida deja de cobrarse: la sustitutiva es la que vale.
          await tx.invoice.updateMany({
            where: { id: existing.rectifiesInvoiceId, status: { in: ['issued', 'overdue'] } },
            data: { status: 'rectified', cancelledAt: new Date() },
          });
        }
      }
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: args.tenantId },
        select: {
          taxId: true,
          timezone: true,
          invoiceDueDays: true,
          billingLegalName: true,
          billingAddress: true,
          billingPostalCode: true,
          billingCity: true,
          verifactuEnabled: true,
        },
      });
      // Plazo de pago: el del inquilino si tiene uno propio; si no, el del negocio.
      const customerDays = existing.customerId
        ? ((
            await tx.customer.findUnique({
              where: { id: existing.customerId },
              select: { invoiceDueDays: true },
            })
          )?.invoiceDueDays ?? null)
        : null;
      const dueDays = customerDays ?? tenant.invoiceDueDays;
      // Fecha de emisión = hoy en la zona del tenant (en UTC, a las 00:30 del
      // día 1 la factura caía en el mes —o trimestre— anterior).
      const issueDate = existing.issueDate ?? todayInTimezone(tenant.timezone);
      const total = Number(existing.total);
      // Rectificativa de abono: no se cobra ni se reclama (queda saldada al
      // emitirse; el dinero, si lo hay, se devuelve aparte).
      const isCredit = total < 0;
      const settled = isCredit || settledZero;

      if (fromHolded) {
        // Emitida en Holded: su número y su registro en Veri*Factu son los de
        // Holded; aquí no hay huella ni envío a la AEAT.
        const holdedRow = await tx.invoice.update({
          where: { id: args.invoiceId },
          data: {
            status: settled ? 'paid' : 'issued',
            invoiceNumber: fromHolded.number,
            issueDate,
            dueDate: settled
              ? null
              : (existing.dueDate ?? this.computeDefaultDueDate(issueDate, dueDays)),
            ...(settled ? { amountPaid: total, paidAt: new Date() } : {}),
            issuedBy: 'holded',
            holdedDocumentId: fromHolded.documentId,
            holdedSyncState: null,
            holdedSyncStartedAt: null,
          },
          include: this.includeRelations(),
        });
        const holdedWithheld = settled
          ? holdedRow
          : await this.applyCreditBalance(
              tx,
              args.tenantId,
              await this.applyWithholding(tx, args.tenantId, holdedRow),
            );
        if (isCredit && existing.rectifiesInvoiceId) {
          compensatedOriginal = await this.compensateWithCredit(tx, {
            tenantId: args.tenantId,
            originalId: existing.rectifiesInvoiceId,
            creditCents: -toCents(total),
            creditNumber: fromHolded.number,
          });
        }
        return holdedWithheld;
      }

      const { sequenceNumber, series } = await this.series.reserveNextNumber(
        tx,
        existing.seriesId,
        issueDate.getUTCFullYear(),
      );
      // La numeración va en orden de fecha: no se emite con una fecha anterior
      // a la última factura de la serie (la serie ya está bloqueada).
      const lastInSeries = await tx.invoice.findFirst({
        where: { seriesId: existing.seriesId, sequenceNumber: { gt: 0 }, issueDate: { not: null } },
        orderBy: { issueDate: 'desc' },
        select: { issueDate: true, invoiceNumber: true },
      });
      if (lastInSeries?.issueDate && issueDate < lastInSeries.issueDate) {
        throw new BadRequestException({
          code: 'issue_date_before_last',
          message: `La fecha de emisión no puede ser anterior a la de la última factura de la serie (${lastInSeries.invoiceNumber}, ${lastInSeries.issueDate.toISOString().slice(0, 10)})`,
        });
      }
      const invoiceNumber = this.series.formatInvoiceNumber(series, sequenceNumber, issueDate);
      const dueDate = existing.dueDate ?? this.computeDefaultDueDate(issueDate, dueDays);

      // Veri*Factu (si el negocio lo tiene activado): huella oficial encadenada
      // con el último registro del emisor (el propietario en el plan
      // Administrador; si no, el tenant), QR y envío a la AEAT. Apagado, la
      // factura se emite sin nada de eso.
      const verifactuOn = tenant.verifactuEnabled;
      const owner = existing.ownerId
        ? await tx.owner.findUnique({
            where: { id: existing.ownerId },
            select: { taxId: true, legalName: true },
          })
        : null;
      const issuerTaxId = owner ? owner.taxId : tenant.taxId;
      const emitterTaxId = issuerTaxId ? normalizeTaxId(issuerTaxId) : '';
      // Sin NIF, razón social y domicilio la factura no es válida (RD 1619/2012).
      await this.assertIssuerFiscalData(tx, existing.ownerId, tenant);
      if (verifactuOn && this.verifactu.realMode) {
        // Envío real a la AEAT: sin NIF válido del emisor el registro se
        // rechazaría (antes la huella llevaba «PENDIENTE»).
        if (!emitterTaxId || !isValidSpanishTaxId(emitterTaxId)) {
          throw new BadRequestException(
            owner
              ? {
                  code: 'owner_tax_id_required',
                  message: `El NIF del propietario ${owner.legalName} no es válido. Corrígelo en Propietarios antes de emitir sus facturas.`,
                }
              : {
                  code: 'tenant_tax_id_required',
                  message:
                    'Pon el NIF de tu empresa en Ajustes → Suscripción (datos fiscales) antes de emitir facturas',
                },
          );
        }
        await this.assertRecipientIdentifiable(tx, existing);
        // Sin un certificado vigente la factura se emitiría y se quedaría sin
        // registrar en la AEAT (el registro debe hacerse al emitir).
        const cert = await tx.tenantAeatCredential.findFirst({
          where: {
            revokedAt: null,
            certValidTo: { gt: new Date() },
            // El del tenant o, si la emite un propietario, el suyo.
            OR: [{ ownerId: null }, ...(existing.ownerId ? [{ ownerId: existing.ownerId }] : [])],
          },
          select: { id: true },
        });
        if (!cert) {
          throw new BadRequestException({
            code: 'aeat_certificate_required',
            message:
              'Sube un certificado digital vigente en Ajustes → Facturación → Veri*Factu antes de emitir facturas',
          });
        }
      }
      const record = verifactuOn
        ? await (async () => {
            // Su registro de alta, encadenado con el último del emisor y
            // guardado tal como se envía.
            const chain = await this.verifactuRecords.createAlta(tx, {
              tenantId: args.tenantId,
              invoiceId: args.invoiceId,
              ownerId: existing.ownerId ?? null,
              invoiceNumber,
              issueDate,
              userId: args.userId,
            });
            const qrCodeUrl = await this.verifactu.buildQrDataUrl({
              tenantTaxId: emitterTaxId || 'PENDIENTE',
              invoiceNumber,
              issueDate,
              total,
            });
            return {
              hash: chain.hash,
              previousHash: chain.previousHash,
              previousInvoiceId: chain.previousInvoiceId,
              chainSeq: chain.chainSeq,
              aeatRecordTimestamp: chain.recordTimestamp,
              qrCodeUrl,
              aeatStatus: 'pending' as const,
            };
          })()
        : {};

      const issuedRow = await tx.invoice.update({
        where: { id: args.invoiceId },
        data: {
          status: settled ? 'paid' : 'issued',
          invoiceNumber,
          sequenceNumber,
          issueDate,
          dueDate: settled ? null : dueDate,
          ...(settled ? { amountPaid: total, paidAt: new Date() } : {}),
          ...record,
        },
        include: this.includeRelations(),
      });
      // Retención de IRPF del contrato (si el inquilino la practica) y, después,
      // su saldo a favor (una devolución que se quedó para la próxima factura).
      const row = settled
        ? issuedRow
        : await this.applyCreditBalance(
            tx,
            args.tenantId,
            await this.applyWithholding(tx, args.tenantId, issuedRow),
          );
      // Un abono por diferencias sobre una factura con importe pendiente lo
      // compensa: la original deja de reclamar lo abonado.
      if (
        isCredit &&
        existing.rectifiesInvoiceId &&
        (existing.correctionMethod ?? 'by_differences') === 'by_differences'
      ) {
        compensatedOriginal = await this.compensateWithCredit(tx, {
          tenantId: args.tenantId,
          originalId: existing.rectifiesInvoiceId,
          creditCents: -toCents(total),
          creditNumber: invoiceNumber,
        });
      }
      return row;
    }, args.tenantId);
    // (Asignado dentro de la transacción: TS no lo ve y lo estrecha a null.)
    const comp = compensatedOriginal as {
      id: string;
      invoiceNumber: string;
      customerId: string | null;
      total: number;
      fullyPaid: boolean;
    } | null;
    if (!settledZero && toCents(Number(existing.total)) > 0 && updated.status === 'paid') {
      // Saldada entera con el saldo a favor del inquilino: como pagada, sin el
      // correo de «pago recibido» (no ha pagado nada ahora).
      this.events.emit(DOMAIN_EVENTS.invoice_paid, {
        tenantId: args.tenantId,
        entityType: 'invoice',
        entityId: updated.id,
        customerId: updated.customerId,
        recipientEmail: null,
        scope: {
          invoice: {
            number: updated.invoiceNumber,
            total: Number(updated.total).toFixed(2),
            paidAt: new Date().toISOString(),
            compensated: true,
          },
        },
      } satisfies DomainEventPayload);
    }
    if (settledZero && updated.status === 'paid') {
      // Saldada sin cobro: avisa como pagada (devuelve el acceso, cierra el
      // escalado) pero sin el correo de «pago recibido».
      this.events.emit(DOMAIN_EVENTS.invoice_paid, {
        tenantId: args.tenantId,
        entityType: 'invoice',
        entityId: updated.id,
        customerId: updated.customerId,
        recipientEmail: null,
        scope: {
          invoice: {
            number: updated.invoiceNumber,
            total: '0.00',
            paidAt: new Date().toISOString(),
            compensated: true,
          },
        },
      } satisfies DomainEventPayload);
    }
    if (comp?.fullyPaid) {
      this.events.emit(DOMAIN_EVENTS.invoice_paid, {
        tenantId: args.tenantId,
        entityType: 'invoice',
        entityId: comp.id,
        customerId: comp.customerId,
        recipientEmail: null,
        scope: {
          invoice: {
            number: comp.invoiceNumber,
            total: comp.total.toFixed(2),
            paidAt: new Date().toISOString(),
            // Saldada con un abono, no con un cobro (sin aviso de «pago recibido»).
            compensated: true,
          },
        },
      } satisfies DomainEventPayload);
    }

    // Envío a la AEAT en segundo plano (VerifactuProcessor): sale con el
    // siguiente envío de su emisor, junto con lo que se emita mientras la
    // AEAT pide esperar. Sin huella no es un registro de Veri*Factu (negocio
    // sin activarlo).
    if (!fromHolded && updated.hash) {
      await this.verifactuDispatcher.schedule(args.tenantId, existing.ownerId ?? null);
    }

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
    // El PDF se genera solo (en el worker): sale en el correo y en el área de clientes.
    this.events.emit(INVOICE_PDF_REQUESTED, {
      tenantId: args.tenantId,
      invoiceId: updated.id,
    } satisfies InvoicePdfRequestedPayload);
    if (existing.rectifiesInvoiceId && existing.correctionMethod === 'by_substitution') {
      // La sustituida deja de valer (copia contable de Holded).
      this.events.emit(DOMAIN_EVENTS.invoice_cancelled, {
        tenantId: args.tenantId,
        invoiceId: existing.rectifiesInvoiceId,
      } satisfies InvoiceCancelledPayload);
      this.events.emit(DOMAIN_EVENTS.invoice_voided, {
        tenantId: args.tenantId,
        invoiceId: existing.rectifiesInvoiceId,
      } satisfies InvoiceVoidedPayload);
    }
    return this.toDto(await this.findOrThrow(args.tenantId, updated.id));
  }

  /**
   * Rectificativa en modo Holded: queda en borrador «pendiente de hacer en
   * Holded». Sale en Ajustes → Facturación → Holded para enlazarla.
   */
  private async awaitHoldedCreditNote(
    tenantId: string,
    existing: InvoiceWithRelations,
  ): Promise<InvoiceDto> {
    if (existing.correctionMethod === 'by_substitution') {
      throw new BadRequestException({
        code: 'holded_substitution_not_supported',
        message:
          'Con Holded como sistema de facturación, rectifica por diferencias (Holded no emite sustitutivas desde la app)',
      });
    }
    await this.prisma.withTenant(async (tx) => {
      await lockInvoiceRow(tx, existing.id);
      if (existing.rectifiesInvoiceId) {
        await this.assertRectificationLimits(tx, {
          originalId: existing.rectifiesInvoiceId,
          selfId: existing.id,
          total: Number(existing.total),
          method: 'by_differences',
        });
      }
      await tx.invoice.updateMany({
        where: { id: existing.id, status: 'draft' },
        data: { holdedSyncState: 'awaiting_holded', issuedBy: 'holded' },
      });
    }, tenantId);
    return this.toDto(await this.findOrThrow(tenantId, existing.id));
  }

  /**
   * Enlaza la rectificativa que el tenant creó en Holded desde la factura
   * original: toma su número de Holded y la da por emitida (y compensa la
   * original si tenía importe pendiente).
   */
  async linkHoldedCreditNote(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    holdedDocumentId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    if (existing.status !== 'draft' || existing.holdedSyncState !== 'awaiting_holded') {
      throw new ConflictException({
        code: 'not_awaiting_holded',
        message: 'Esta factura no está pendiente de enlazar con Holded',
      });
    }
    let number: string | null;
    try {
      number = await this.holdedSync.creditNoteNumber(args.tenantId, args.holdedDocumentId);
    } catch (err) {
      throw new BadGatewayException({
        code: 'holded_request_failed',
        message: `No se pudo leer la rectificativa en Holded: ${err instanceof Error ? err.message : 'error desconocido'}`,
      });
    }
    if (!number) {
      throw new BadRequestException({
        code: 'holded_document_not_issued',
        message: 'Esa rectificativa de Holded aún no tiene número: apruébala en Holded primero',
      });
    }
    return this.issue({
      tenantId: args.tenantId,
      userId: args.userId,
      invoiceId: args.invoiceId,
      meta: args.meta,
      holdedDocument: { documentId: args.holdedDocumentId, number },
      ...(args.facilityScope !== undefined ? { facilityScope: args.facilityScope } : {}),
    });
  }

  /**
   * Emite la factura en Holded (modo 'holded'). Reserva la factura antes de
   * llamar a Holded (dos «Emitir» a la vez no crean dos facturas allí) y
   * reanuda una emisión que se quedó a medias (creada pero sin aprobar o sin
   * número). Si Holded no respondió al crearla, la factura queda reservada y
   * sale «para revisar» en Ajustes → Facturación.
   */
  private async issueInHolded(
    tenantId: string,
    existing: InvoiceWithRelations,
  ): Promise<{ documentId: string; number: string }> {
    if (existing.rectifiesInvoiceId && existing.correctionMethod === 'by_substitution') {
      throw new BadRequestException({
        code: 'holded_substitution_not_supported',
        message:
          'Con Holded como sistema de facturación, rectifica por diferencias (Holded no emite sustitutivas desde la app)',
      });
    }
    const cfg = await this.holdedSettings.resolveIssuing(tenantId);
    if ('reason' in cfg) {
      throw new BadRequestException({ code: 'holded_issuing_not_ready', message: cfg.reason });
    }
    await this.prisma.withTenant(async (tx) => {
      await lockInvoiceRow(tx, existing.id);
      const fresh = await tx.invoice.findUniqueOrThrow({
        where: { id: existing.id },
        select: { status: true, holdedSyncState: true, holdedDocumentId: true, issueDate: true },
      });
      if (fresh.status !== 'draft') {
        throw new ConflictException({
          code: 'invoice_already_issued',
          message: 'La factura ya se ha emitido',
        });
      }
      if (fresh.holdedSyncState === 'creating') {
        throw new ConflictException({
          code: 'invoice_issue_in_progress',
          message:
            'Esta factura se está emitiendo en Holded o hay que comprobarla allí (Ajustes → Facturación → Holded)',
        });
      }
      if (existing.rectifiesInvoiceId) {
        await this.assertRectificationLimits(tx, {
          originalId: existing.rectifiesInvoiceId,
          selfId: existing.id,
          total: Number(existing.total),
          method: 'by_differences',
        });
      }
      if (!fresh.holdedDocumentId) {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { timezone: true, invoiceDueDays: true },
        });
        const issueDate = fresh.issueDate ?? todayInTimezone(tenant.timezone);
        await tx.invoice.update({
          where: { id: existing.id },
          data: {
            holdedSyncState: 'creating',
            holdedSyncStartedAt: new Date(),
            issueDate,
            ...(existing.dueDate || Number(existing.total) <= 0
              ? {}
              : { dueDate: this.computeDefaultDueDate(issueDate, tenant.invoiceDueDays) }),
          },
        });
      }
    }, tenantId);
    try {
      return await this.holdedSync.issueDocument(tenantId, existing.id, cfg);
    } catch (err) {
      throw new BadGatewayException({
        code: 'holded_issue_failed',
        message: `No se pudo emitir la factura en Holded: ${err instanceof Error ? err.message : 'error desconocido'}`,
      });
    }
  }

  /**
   * Emite N borradores en lote (cierre mensual). Procesa cada uno de forma
   * independiente: un fallo (ya emitida, sin serie, etc.) no tumba el resto; se
   * reporta en `failed`. Evita el cuello de botella de emitir factura a factura.
   */
  async bulkIssue(args: {
    tenantId: string;
    userId: string;
    ids: string[];
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<BulkInvoiceActionResultDto> {
    const succeeded: string[] = [];
    const failed: BulkInvoiceActionResultDto['failed'] = [];
    for (const invoiceId of args.ids) {
      try {
        await this.issue({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId,
          meta: args.meta,
          // Quien solo ve unos locales no emite facturas de otros.
          facilityScope: args.facilityScope ?? null,
        });
        succeeded.push(invoiceId);
      } catch (err) {
        failed.push(await this.bulkFailure(args.tenantId, invoiceId, err));
      }
    }
    return { succeeded, failed };
  }

  /** Fila de error de una acción en lote: código, texto legible y número. */
  async bulkFailure(
    tenantId: string,
    invoiceId: string,
    err: unknown,
  ): Promise<BulkInvoiceActionResultDto['failed'][number]> {
    const row = await this.prisma
      .withTenant(
        (tx) =>
          tx.invoice.findFirst({
            where: { id: invoiceId },
            select: { invoiceNumber: true, sequenceNumber: true },
          }),
        tenantId,
      )
      .catch(() => null);
    return {
      id: invoiceId,
      error: this.errorCode(err),
      message: this.errorMessage(err),
      invoiceNumber: row && row.sequenceNumber > 0 ? row.invoiceNumber : null,
    };
  }

  /**
   * Envía en lote un recordatorio de pago a N facturas pendientes (issued/overdue).
   * Manual, distinto del dunning automático: el staff dispara un aviso puntual desde
   * la lista de facturas. Procesa cada una de forma independiente (un fallo —factura
   * no pendiente, sin email— no tumba el resto) y reporta en `failed`. Reutiliza la
   * plantilla `invoice_overdue_email` (trigger `invoice_overdue`).
   */
  /** Recuerda lo vencido a varios inquilinos: una por cada factura vencida. */
  async remindCustomers(args: {
    tenantId: string;
    customerIds: string[];
    facilityScope?: string[] | null;
  }): Promise<BulkInvoiceActionResultDto> {
    const rows = await this.prisma.withTenant(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { timezone: true } });
      const today = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
      const inScope = invoiceFacilityWhere(args.facilityScope ?? null) as Prisma.InvoiceWhereInput;
      return tx.invoice.findMany({
        where: {
          AND: [overdueInvoiceWhere(today), inScope],
          customerId: { in: args.customerIds },
        },
        select: { id: true },
      });
    }, args.tenantId);
    return this.bulkRemind({
      tenantId: args.tenantId,
      ids: rows.map((r) => r.id),
      ...(args.facilityScope ? { facilityScope: args.facilityScope } : {}),
    });
  }

  async bulkRemind(args: {
    tenantId: string;
    ids: string[];
    facilityScope?: string[] | null;
  }): Promise<BulkInvoiceActionResultDto> {
    const succeeded: string[] = [];
    const failed: BulkInvoiceActionResultDto['failed'] = [];
    // Un solo correo por inquilino: con varias facturas suyas, uno que las lista.
    const owners = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { id: { in: args.ids } },
          select: { id: true, customerId: true },
        }),
      args.tenantId,
    );
    const byCustomer = new Map<string, string[]>();
    for (const row of owners) {
      if (!row.customerId) continue;
      byCustomer.set(row.customerId, [...(byCustomer.get(row.customerId) ?? []), row.id]);
    }
    const grouped = new Set<string>();
    for (const [customerId, ids] of byCustomer) {
      if (ids.length < 2) continue;
      for (const id of ids) grouped.add(id);
      const res = await this.sendReminderSummary(
        args.tenantId,
        customerId,
        ids,
        args.facilityScope,
      );
      succeeded.push(...res.sent);
      failed.push(...res.failed);
    }
    for (const invoiceId of args.ids) {
      if (grouped.has(invoiceId)) continue;
      try {
        await this.sendReminderForInvoice(args.tenantId, invoiceId, args.facilityScope);
        succeeded.push(invoiceId);
      } catch (err) {
        failed.push(await this.bulkFailure(args.tenantId, invoiceId, err));
      }
    }
    return { succeeded, failed };
  }

  /**
   * Varias facturas del mismo inquilino: se comprueba cada una como en el
   * recordatorio individual y las que pueden recordarse van en UN correo.
   */
  private async sendReminderSummary(
    tenantId: string,
    customerId: string,
    ids: string[],
    facilityScope?: string[] | null,
  ): Promise<{ sent: string[]; failed: BulkInvoiceActionResultDto['failed'] }> {
    const failed: BulkInvoiceActionResultDto['failed'] = [];
    const ok: { id: string; number: string; pending: number; dueDate: Date | null }[] = [];
    for (const id of ids) {
      try {
        ok.push(await this.reminderCandidate(tenantId, id, facilityScope));
      } catch (err) {
        failed.push(await this.bulkFailure(tenantId, id, err));
      }
    }
    if (ok.length === 0) return { sent: [], failed };
    if (ok.length === 1) {
      try {
        await this.sendReminderForInvoice(tenantId, ok[0]!.id, facilityScope);
        return { sent: [ok[0]!.id], failed };
      } catch (err) {
        return { sent: [], failed: [...failed, await this.bulkFailure(tenantId, ok[0]!.id, err)] };
      }
    }
    const data = await this.prisma.withTenant(async (tx) => {
      const [customer, tenant] = await Promise.all([
        tx.customer.findFirst({
          where: { id: customerId },
          select: {
            email: true,
            billingEmail: true,
            firstName: true,
            companyName: true,
            customerType: true,
            locale: true,
          },
        }),
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            slug: true,
            customDomain: true,
            customDomainVerifiedAt: true,
            timezone: true,
          },
        }),
      ]);
      return { customer, tenant };
    }, tenantId);
    const email = data.customer?.billingEmail ?? data.customer?.email;
    if (!email) {
      for (const c of ok) {
        failed.push({
          id: c.id,
          error: 'customer_email_missing',
          message: 'El inquilino no tiene email',
          invoiceNumber: c.number,
        });
      }
      return { sent: [], failed };
    }
    const locale = emailLocale(data.customer?.locale);
    const summary = buildReminderSummary({
      tenantName: data.tenant.name,
      customerName:
        (data.customer?.customerType === 'business'
          ? data.customer.companyName
          : data.customer?.firstName) ?? '',
      locale,
      invoices: ok.map((c) => ({ number: c.number, pending: c.pending, dueDate: c.dueDate })),
      portalUrl: tenantPortalLoginUrl(
        this.config.get('WEB_BASE_URL', { infer: true }),
        data.tenant,
      ),
      today: todayInTimezone(data.tenant.timezone),
    });
    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: email,
      subject: summary.subject,
      bodyText: summary.text,
      customerId,
      invoiceId: ok[0]!.id,
      variables: { invoiceIds: ok.map((c) => c.id) },
      source: 'bulk.reminder_summary',
    });
    return { sent: ok.map((c) => c.id), failed };
  }

  /** Lo que se le recordaría de una factura (o por qué no se le puede recordar). */
  private async reminderCandidate(
    tenantId: string,
    invoiceId: string,
    facilityScope?: string[] | null,
  ): Promise<{ id: string; number: string; pending: number; dueDate: Date | null }> {
    const row = await this.prisma.withTenant(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, deletedAt: null },
        select: {
          invoiceNumber: true,
          status: true,
          total: true,
          amountPaid: true,
          dueDate: true,
          contract: { select: { unit: { select: { facilityId: true } } } },
        },
      });
      if (!invoice) return null;
      const [inFlight, plan, recent] = await Promise.all([
        hasPaymentInFlight(tx, invoiceId),
        tx.paymentPlan.findFirst({
          where: { status: 'active', invoiceIds: { has: invoiceId } },
          select: { id: true },
        }),
        tx.communication.findFirst({
          where: {
            ...remindersOfInvoice(invoiceId),
            createdAt: { gte: new Date(Date.now() - REMINDER_GAP_MS) },
          },
          select: { id: true },
        }),
      ]);
      return { invoice, inFlight, inPlan: !!plan, recent: !!recent };
    }, tenantId);
    if (!row) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const facilityId = row.invoice.contract?.unit?.facilityId;
    if (facilityId) assertFacilityAllowed(facilityScope, facilityId);
    if (row.invoice.status !== 'issued' && row.invoice.status !== 'overdue') {
      throw new BadRequestException({
        code: 'invoice_not_pending',
        message: 'Solo se puede recordar una factura emitida o vencida',
      });
    }
    if (row.inFlight) {
      throw new ConflictException({
        code: 'payment_in_progress',
        message: 'Esta factura ya tiene un cobro en curso',
      });
    }
    if (row.inPlan) {
      throw new ConflictException({
        code: 'invoice_in_payment_plan',
        message: 'Esta factura va en un plan de pagos',
      });
    }
    if (row.recent) {
      throw new ConflictException({
        code: 'reminder_recently_sent',
        message: 'Ya se le recordó esta factura en las últimas 24 horas',
      });
    }
    return {
      id: invoiceId,
      number: row.invoice.invoiceNumber,
      pending: Number(subtractAmounts(row.invoice.total, row.invoice.amountPaid)),
      dueDate: row.invoice.dueDate,
    };
  }

  /**
   * Encola un recordatorio de pago para UNA factura. Valida que esté pendiente de
   * cobro (issued/overdue), respeta el alcance por local y exige un cliente con
   * email (una F2 sin destinatario no es recordable). Lanza con un `code` claro
   * en cada caso para que `bulkRemind` lo reporte.
   */
  private async sendReminderForInvoice(
    tenantId: string,
    invoiceId: string,
    facilityScope?: string[] | null,
  ): Promise<void> {
    const data = await this.prisma.withTenant(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, deletedAt: null },
        select: {
          invoiceNumber: true,
          status: true,
          total: true,
          amountPaid: true,
          amountRefunded: true,
          dueDate: true,
          customerId: true,
          contractId: true,
          customer: {
            select: {
              email: true,
              billingEmail: true,
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
              locale: true,
            },
          },
          contract: { select: { unit: { select: { facilityId: true } } } },
        },
      });
      if (!invoice) return null;
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
      });
      const [inFlight, plan, lastReminder] = await Promise.all([
        hasPaymentInFlight(tx, invoiceId),
        tx.paymentPlan.findFirst({
          where: { status: 'active', invoiceIds: { has: invoiceId } },
          select: { id: true },
        }),
        tx.communication.findFirst({
          where: {
            ...remindersOfInvoice(invoiceId),
            createdAt: { gte: new Date(Date.now() - REMINDER_GAP_MS) },
          },
          select: { id: true },
        }),
      ]);
      const timezone =
        (await tx.tenant.findFirst({ select: { timezone: true } }))?.timezone ?? 'Europe/Madrid';
      return {
        invoice,
        tenant,
        inFlight,
        inPlan: !!plan,
        recentlyReminded: !!lastReminder,
        today: todayInTimezone(timezone),
      };
    }, tenantId);

    if (!data) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const { invoice, tenant, inFlight, inPlan, recentlyReminded, today } = data;

    const facilityId = invoice.contract?.unit?.facilityId;
    if (facilityId) assertFacilityAllowed(facilityScope, facilityId);

    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      throw new BadRequestException({
        code: 'invoice_not_pending',
        message: 'Solo se puede recordar una factura emitida o vencida',
      });
    }
    // No se pide pagar a quien ya está pagando.
    if (inFlight) {
      throw new ConflictException({
        code: 'payment_in_progress',
        message: 'Esta factura ya tiene un cobro en curso',
      });
    }
    if (inPlan) {
      throw new ConflictException({
        code: 'invoice_in_payment_plan',
        message: 'Esta factura va en un plan de pagos',
      });
    }
    // Uno al día como mucho: dos seguidos (doble clic, o desde la lista y la
    // ficha) le llegaban dos correos iguales al inquilino.
    if (recentlyReminded) {
      throw new ConflictException({
        code: 'reminder_recently_sent',
        message: 'Ya se le recordó esta factura en las últimas 24 horas',
      });
    }
    const customer = invoice.customer;
    if (!invoice.customerId || !customer?.email) {
      throw new BadRequestException({
        code: 'customer_email_missing',
        message: 'La factura no tiene un cliente con email',
      });
    }

    const amountPending = subtractAmounts(invoice.total, invoice.amountPaid);
    const daysOverdue = invoice.dueDate
      ? Math.max(0, Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000))
      : 0;
    // Aún no ha vencido: otro texto («vence el…», no «venció el…»).
    const overdue = invoice.status === 'overdue' || (!!invoice.dueDate && invoice.dueDate < today);
    const locale = emailLocale(customer.locale);
    const displayName =
      customer.customerType === 'business'
        ? (customer.companyName ?? 'Empresa sin nombre')
        : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';

    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: customer.billingEmail ?? customer.email,
      invoiceId,
      contractId: invoice.contractId,
      templateCode: overdue ? 'invoice_overdue_email' : 'invoice_due_reminder_email',
      trigger: 'invoice_overdue',
      // Las mismas variables que el recordatorio del escalado de impago: importes
      // y fecha legibles y el enlace para pagar (sin él, «Pagar ahora» salía vacío).
      variables: {
        customer: { firstName: customer.firstName ?? '', displayName },
        invoice: {
          number: invoice.invoiceNumber,
          total: formatEur(invoice.total, locale),
          amountPending: formatEur(amountPending, locale),
          dueDate: invoice.dueDate ? formatDateLong(invoice.dueDate, 'Europe/Madrid', locale) : '',
          daysOverdue,
        },
        portal: {
          url: tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant),
        },
        tenant: { name: tenant.name },
      },
      customerId: invoice.customerId,
      source: 'bulk.manual_reminder',
    });
  }

  /** Texto de una excepción Nest para enseñarlo tal cual. */
  private errorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'response' in err) {
      const res = (err as { response?: unknown }).response;
      if (res && typeof res === 'object' && 'message' in res) {
        const m = (res as { message: unknown }).message;
        if (typeof m === 'string') return m;
      }
    }
    return 'No se ha podido hacer';
  }

  /** Extrae el `code` de una excepción Nest (o su mensaje) para el reporte en lote. */
  private errorCode(err: unknown): string {
    if (err && typeof err === 'object' && 'response' in err) {
      const res = (err as { response?: unknown }).response;
      if (res && typeof res === 'object' && 'code' in res) {
        return String((res as { code: unknown }).code);
      }
    }
    return err instanceof Error ? err.message : 'unknown_error';
  }

  /** Lo que se cobraría de recargo por esta factura (sin emitir nada). */
  async lateFeePreview(
    tenantId: string,
    invoiceId: string,
    facilityScope?: string[] | null,
  ): Promise<LateFeePreviewDto> {
    await this.findOrThrow(tenantId, invoiceId, facilityScope);
    const { fee, type, value } = await this.prisma.withTenant(
      (tx) => this.lateFeeFor(tx, tenantId, invoiceId),
      tenantId,
    );
    return { amount: fee, type, value };
  }

  /**
   * Comprueba que a la factura le toca recargo y calcula cuánto: emitida y ya
   * vencida, sin recargo previo, que no sea ella misma un recargo y con el
   * recargo activado en el negocio.
   */
  private async lateFeeFor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    invoiceId: string,
  ): Promise<{
    customerId: string;
    contractId: string | null;
    invoiceLabel: string;
    fee: number;
    ownerId: string | null;
    type: 'percentage' | 'fixed';
    value: number;
  }> {
    const original = await tx.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        customerId: true,
        contractId: true,
        total: true,
        amountPaid: true,
        dueDate: true,
        kind: true,
        ownerId: true,
        lateFeeForInvoiceId: true,
        lateFeeInvoice: { select: { id: true } },
      },
    });
    if (!original) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    if (original.kind === 'deposit_receipt') {
      throw new BadRequestException({
        code: 'invoice_not_chargeable',
        message: 'Una fianza no lleva recargo por mora',
      });
    }
    // Nunca recargo sobre recargo.
    if (original.lateFeeForInvoiceId) {
      throw new BadRequestException({
        code: 'late_fee_on_late_fee',
        message: 'Esta factura ya es un recargo por mora: no lleva otro',
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
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { lateFeeEnabled: true, lateFeeType: true, lateFeeValue: true, timezone: true },
    });
    const today = todayInTimezone(tenant.timezone);
    const overdue =
      original.status === 'overdue' ||
      (original.status === 'issued' && !!original.dueDate && original.dueDate < today);
    if (!overdue) {
      throw new BadRequestException({
        code: 'invoice_not_overdue',
        message: 'Solo se aplica recargo a una factura ya vencida',
      });
    }
    if (!tenant.lateFeeEnabled) {
      throw new BadRequestException({
        code: 'late_fee_disabled',
        message: 'Activa el recargo por mora en Configuración → Facturación para aplicarlo',
      });
    }
    // El porcentaje se aplica a lo que sigue pendiente, no al total: una
    // factura pagada a medias solo recarga la parte impagada.
    const base =
      Math.max(0, toCents(Number(original.total)) - toCents(Number(original.amountPaid))) / 100;
    const value = Number(tenant.lateFeeValue);
    const type = tenant.lateFeeType === 'fixed' ? 'fixed' : 'percentage';
    // Cálculo en céntimos enteros: base*% sobre floats arrastra drift al recargo.
    const fee =
      type === 'percentage'
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
      contractId: original.contractId,
      invoiceLabel: original.invoiceNumber ?? original.id,
      fee,
      ownerId: original.ownerId,
      type,
      value,
    };
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
    facilityScope?: string[] | null;
    userId: string | null;
  }): Promise<InvoiceDto> {
    const { tenantId, invoiceId } = args;
    // Alcance por local: asertar antes de crear el recargo.
    await this.findOrThrow(tenantId, invoiceId, args.facilityScope);
    const { customerId, contractId, invoiceLabel, fee, ownerId } = await this.prisma.withTenant(
      (tx) => this.lateFeeFor(tx, tenantId, invoiceId),
      tenantId,
    );

    // Lo emite el mismo emisor que la vencida (el propietario, si lo hay).
    const series = ownerId ? null : await this.series.getDefault(tenantId);
    if (!ownerId && !series) {
      throw new BadRequestException({
        code: 'no_default_series',
        message: 'No hay serie de facturación por defecto',
      });
    }

    const created = await this.create({
      tenantId,
      userId: args.userId,
      ownerId,
      input: {
        invoiceType: 'F1',
        customerId,
        // Del contrato de la vencida: sale en su ficha y en su local.
        ...(contractId ? { contractId } : {}),
        ...(series ? { seriesId: series.id } : {}),
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
    // Enlazar a la original (idempotencia real: constraint único en
    // `lateFeeForInvoiceId`). El SELECT de arriba solo evita el caso común
    // (recargo ya aplicado); dos llamadas CONCURRENTES (doble clic, o el cron
    // de dunning + un clic manual a la vez) pasan ambas ese check y cada una
    // crea su propia factura de recargo — el UPDATE que las enlaza es el
    // árbitro real: solo una lo consigue, la otra choca contra el índice único
    // y su factura recién creada queda huérfana (sin enlazar, sin emitir) →
    // se cancela en vez de dejarla suelta.
    try {
      await this.prisma.withTenant(
        (tx) =>
          tx.invoice.update({
            where: { id: created.id },
            data: { lateFeeForInvoiceId: invoiceId },
          }),
        tenantId,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        await this.cancel({
          tenantId,
          userId: args.userId,
          invoiceId: created.id,
          ...(args.facilityScope !== undefined ? { facilityScope: args.facilityScope } : {}),
          input: { reason: 'Recargo duplicado (carrera con otra petición)' },
          meta: {},
        }).catch(() => undefined);
        throw new ConflictException({
          code: 'late_fee_already_applied',
          message: 'Esta factura ya tiene un recargo por mora',
        });
      }
      throw err;
    }
    return this.issue({ tenantId, userId: args.userId, invoiceId: created.id, meta: {} });
  }

  /**
   * Vuelve a enviar a la AEAT el último registro de una factura:
   *   - si no llegó o no se sabe (`pending`/`error`), el mismo registro;
   *   - si la AEAT lo rechazó o lo aceptó con avisos, un registro nuevo de
   *     subsanación con los datos corregidos (el original no se toca): alta
   *     con Subsanacion=S —RechazoPrevio=X si la AEAT no tiene la factura, S
   *     si la tiene— o, si era una anulación, otra anulación.
   * Una aceptada no se reenvía (sería un alta duplicada).
   */
  async resendAeat(
    invoiceId: string,
    tenantId: string,
    facilityScope?: string[] | null,
    opts: { userId?: string | null; reason?: string | null } = {},
  ): Promise<{ queued: true; invoiceId: string; subsanacion: boolean }> {
    const existing = await this.findOrThrow(tenantId, invoiceId, facilityScope);
    if (existing.status === 'draft' || (existing.status === 'cancelled' && !existing.voidedAt)) {
      throw new BadRequestException({
        code: 'invoice_draft_not_sendable',
        message: 'No se puede reenviar a AEAT una factura en borrador',
      });
    }
    // Un justificante de fianza no es una factura: no va a la AEAT.
    if (existing.kind === 'deposit_receipt') {
      throw new BadRequestException({
        code: 'not_an_invoice',
        message: 'Un justificante de fianza no se envía a la AEAT',
      });
    }
    if (existing.issuedBy === 'holded') {
      throw new BadRequestException({
        code: 'issued_by_holded',
        message: 'Esta factura la emitió Holded: su registro en Veri*Factu se gestiona allí',
      });
    }
    this.assertVerifactuRecord(existing);
    const ownerId = existing.ownerId ?? null;
    const reason = opts.reason?.trim() || null;
    const subsanacion = await this.prisma.withTenant(async (tx) => {
      await lockInvoiceRow(tx, invoiceId);
      const latest = await this.verifactuRecords.latest(tx, invoiceId);
      if (!latest) {
        throw new BadRequestException({
          code: 'not_a_verifactu_record',
          message: 'Esta factura no tiene registro de Veri*Factu',
        });
      }
      // Ya registrada en la AEAT: reenviarla sería un alta duplicada.
      if (latest.status === 'accepted') {
        throw new BadRequestException({
          code: 'already_accepted',
          message:
            latest.kind === 'anulacion'
              ? 'La AEAT ya registró la anulación de esta factura'
              : 'La AEAT ya aceptó esta factura: no se reenvía',
        });
      }
      if (latest.status === 'pending' || latest.status === 'error') {
        // Se conserva `sentAt` (el último intento). Si un envío anterior llegó,
        // la AEAT contesta «duplicado» con lo que tiene.
        await tx.verifactuRecord.update({
          where: { id: latest.id },
          data: { status: 'pending', csv: null, response: Prisma.JsonNull },
        });
        await this.verifactuRecords.syncInvoices(tx, [invoiceId]);
        return false;
      }
      if (existing.status === 'rectified') {
        throw new BadRequestException({
          code: 'invoice_rectified',
          message:
            'Esta factura ya se rectificó: vale su rectificativa, que lleva su propio registro',
        });
      }
      // ¿La tiene la AEAT? (alguna de sus altas se registró)
      const registered =
        (await tx.verifactuRecord.count({
          where: {
            invoiceId,
            kind: 'alta',
            status: { in: ['accepted', 'accepted_with_warnings'] },
          },
        })) > 0;
      if (latest.kind === 'anulacion') {
        // Anulación rechazada: otra, por rechazo (la AEAT tiene la factura) o
        // sin registro previo (no la tiene).
        await this.verifactuRecords.createAnulacion(tx, {
          tenantId,
          invoiceId,
          ownerId,
          sinRegistroPrevio: !registered,
          rechazoPrevio: registered,
          reason,
          userId: opts.userId ?? null,
        });
      } else {
        await this.verifactuRecords.createAlta(tx, {
          tenantId,
          invoiceId,
          ownerId,
          subsanacion: true,
          // Aceptada con avisos: subsanación sin rechazo previo.
          rechazoPrevio: latest.status === 'rejected' ? (registered ? 'S' : 'X') : null,
          reason,
          userId: opts.userId ?? null,
        });
      }
      await this.verifactuRecords.syncInvoices(tx, [invoiceId]);
      return true;
    }, tenantId);
    // Sin esperar al reintento de un envío fallido; la espera que pidió la AEAT
    // entre un envío y otro sí se respeta.
    await this.verifactuDispatcher.schedule(tenantId, ownerId, { retryNow: true });
    if (subsanacion) {
      await this.audit.write({
        tenantId,
        userId: opts.userId ?? null,
        action: 'invoice.verifactu_corrected',
        entityType: 'Invoice',
        entityId: invoiceId,
        changes: { reason },
        ipAddress: null,
        userAgent: null,
      });
    }
    this.logger.log(
      `[verifactu] ${subsanacion ? 'subsanación' : 'reenvío'} encolado para invoice ${invoiceId} (tenant ${tenantId})`,
    );
    return { queued: true, invoiceId, subsanacion };
  }

  /** Los registros de Veri*Factu de una factura, en el orden de la cadena. */
  async listVerifactuRecords(
    invoiceId: string,
    tenantId: string,
    facilityScope?: string[] | null,
  ): Promise<VerifactuRecordDto[]> {
    await this.findOrThrow(tenantId, invoiceId, facilityScope);
    return this.prisma.withTenant(
      (tx) => this.verifactuRecords.listForInvoice(tx, invoiceId),
      tenantId,
    );
  }

  /** Emitida sin Veri*Factu (el negocio no lo tenía activado): no hay registro que enviar. */
  private assertVerifactuRecord(invoice: { hash: string | null }): void {
    if (!invoice.hash) {
      throw new BadRequestException({
        code: 'not_a_verifactu_record',
        message:
          'Esta factura se emitió sin Veri*Factu (no estaba activado): no se envía a la AEAT',
      });
    }
  }

  /**
   * Consulta a AEAT el estado actual de la factura (sub-bloque 15A.1).
   * Llama a `VerifactuService.refreshStatus` y devuelve el DTO actualizado
   * para que la UI pueda refrescar el badge inmediatamente. Usado por el
   * boton "Consultar AEAT" del badge cuando la factura quedo `pending`
   * o `error`.
   */
  async refreshAeatStatus(
    invoiceId: string,
    tenantId: string,
    facilityScope?: string[] | null,
  ): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(tenantId, invoiceId, facilityScope);
    if (existing.kind === 'deposit_receipt') {
      throw new BadRequestException({
        code: 'not_an_invoice',
        message: 'Un justificante de fianza no se envía a la AEAT',
      });
    }
    if (existing.status === 'draft') {
      throw new BadRequestException({
        code: 'invoice_draft_not_sendable',
        message: 'No se puede consultar a AEAT una factura en borrador',
      });
    }
    this.assertVerifactuRecord(existing);
    await this.verifactu.refreshStatus(invoiceId, tenantId);
    return this.toDto(await this.findOrThrow(tenantId, invoiceId));
  }

  /**
   * Anula una factura.
   * - Borrador → `cancelled` (no tiene número ni efecto fiscal).
   * - Emitida (issued/overdue) y sin cobros → `rectified` + rectificativa de
   *   abono por el total, emitida en el acto (R4; R5 si la original es una
   *   simplificada). La original sigue en los informes fiscales y la
   *   rectificativa resta; Holded recibe la rectificativa.
   * Con cobros hay que reembolsar o rectificar a mano (400 `invoice_has_payments`).
   */
  async cancel(args: {
    tenantId: string;
    /** `null` cuando lo lanza un proceso automático (cron de bookings impagados). */
    userId: string | null;
    invoiceId: string;
    facilityScope?: string[] | null;
    input: CancelInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    if (existing.kind === 'deposit_receipt') {
      return this.cancelDepositReceipt(args);
    }
    if (existing.status !== 'draft') {
      return this.cancelIssued(args);
    }
    this.assertTransition(existing.status as InvoiceStatusValue, 'cancelled');
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.updateMany({
          where: { id: args.invoiceId, status: 'draft' },
          data: { status: 'cancelled', cancelledAt: new Date() },
        }),
      args.tenantId,
    );
    if (count === 0) {
      // Se emitió entre la lectura y la anulación: se anula como emitida.
      return this.cancelIssued(args);
    }
    // El mes gratis, la señal o la recompensa que gastaba vuelven al contrato.
    await this.releaseConsumedBenefits(args.tenantId, args.invoiceId);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findUniqueOrThrow({
          where: { id: args.invoiceId },
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
    this.events.emit(DOMAIN_EVENTS.invoice_cancelled, {
      tenantId: args.tenantId,
      invoiceId: updated.id,
    } satisfies InvoiceCancelledPayload);
    return this.toDto(updated);
  }

  /**
   * Justificante de fianza (no es una factura): se anula sin rectificativa si
   * no tiene cobros. Si ya se cobró, se devuelve con la liquidación de la
   * fianza del contrato.
   */
  private async cancelDepositReceipt(args: {
    tenantId: string;
    userId: string | null;
    invoiceId: string;
    input: CancelInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const updated = await this.prisma.withTenant(async (tx) => {
      await lockInvoiceRow(tx, args.invoiceId);
      const fresh = await tx.invoice.findUniqueOrThrow({ where: { id: args.invoiceId } });
      if (fresh.status !== 'issued' && fresh.status !== 'overdue') {
        throw new BadRequestException({
          code: 'invoice_not_cancellable',
          message: 'El justificante ya está cobrado o anulado',
        });
      }
      if (isGreaterThan(fresh.amountPaid, 0)) {
        throw new BadRequestException({
          code: 'invoice_has_payments',
          message: 'La fianza ya se cobró: devuélvela al liquidar la fianza del contrato',
        });
      }
      await assertNotInSepaRemittance(tx, args.invoiceId);
      return tx.invoice.update({
        where: { id: args.invoiceId },
        data: { status: 'cancelled', cancelledAt: new Date() },
        include: this.includeRelations(),
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.deposit_receipt_cancelled',
      entityType: 'Invoice',
      entityId: updated.id,
      changes: { reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  /**
   * Justificante de fianza de un contrato: documento aparte de la factura (la
   * fianza es una garantía, no una venta: sin IVA, sin Veri*Factu y fuera de
   * los informes fiscales, de Holded y de los ingresos). Número `FZ-<contrato>`
   * fuera de la numeración fiscal. `bundledWithInvoiceId`: la factura con la
   * que se cobra en un solo pago.
   */
  async createDepositReceipt(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    customerId: string;
    contractNumber: string;
    amount: number;
    dueDate: Date | null;
    bundledWithInvoiceId: string | null;
  }): Promise<InvoiceDto> {
    const series = await this.series.getDefault(args.tenantId);
    if (!series) {
      throw new BadRequestException({
        code: 'invoice_series_required',
        message: 'Crea una serie de facturación antes de cobrar fianzas',
      });
    }
    const base = `FZ-${args.contractNumber}`;
    const created = await this.prisma.withTenant(async (tx) => {
      const taken = await tx.invoice.count({
        where: { invoiceNumber: { startsWith: base } },
      });
      const ownerOfContract = await tx.contract.findFirst({
        where: { id: args.contractId },
        select: { ownerId: true },
      });
      return tx.invoice.create({
        data: {
          tenantId: args.tenantId,
          customerId: args.customerId,
          contractId: args.contractId,
          // Del propietario del contrato (para su liquidación), aunque no sea fiscal.
          ...(ownerOfContract?.ownerId ? { ownerId: ownerOfContract.ownerId } : {}),
          seriesId: series.id,
          sequenceNumber: 0,
          invoiceNumber: taken === 0 ? base : `${base}-${taken + 1}`,
          kind: 'deposit_receipt',
          status: 'issued',
          invoiceType: 'F1',
          issueDate: new Date(),
          ...(args.dueDate ? { dueDate: args.dueDate } : {}),
          bundledWithInvoiceId: args.bundledWithInvoiceId,
          subtotal: args.amount,
          taxAmount: 0,
          total: args.amount,
          notes:
            'Justificante de fianza: garantía reembolsable al terminar el contrato. No es una factura.',
          items: {
            create: [
              {
                tenantId: args.tenantId,
                description: `Fianza del contrato ${args.contractNumber}`,
                quantity: 1,
                unitPrice: args.amount,
                taxRate: 0,
                taxAmount: 0,
                total: args.amount,
                relatedContractId: args.contractId,
                position: 0,
              },
            ],
          },
        },
        include: this.includeRelations(),
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.deposit_receipt_created',
      entityType: 'Invoice',
      entityId: created.id,
      changes: { contractId: args.contractId, amount: args.amount },
      ipAddress: null,
      userAgent: null,
    });
    this.events.emit(INVOICE_PDF_REQUESTED, {
      tenantId: args.tenantId,
      invoiceId: created.id,
    } satisfies InvoicePdfRequestedPayload);
    return this.toDto(created);
  }

  /** Anula una factura emitida con una rectificativa de abono por el total. */
  private async cancelIssued(args: {
    tenantId: string;
    userId: string | null;
    invoiceId: string;
    input: CancelInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const reason = args.input.reason?.trim() || 'Anulación de la factura';
    // La rectificativa también lleva los datos fiscales del emisor: se comprueba
    // antes de tocar nada (si no, la original quedaba anulada sin su abono).
    await this.prisma.withTenant(async (tx) => {
      const row = await tx.invoice.findUniqueOrThrow({
        where: { id: args.invoiceId },
        select: { ownerId: true, issuedBy: true },
      });
      if (row.issuedBy === 'holded') return;
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: args.tenantId },
        select: {
          taxId: true,
          billingLegalName: true,
          billingAddress: true,
          billingPostalCode: true,
          billingCity: true,
        },
      });
      await this.assertIssuerFiscalData(tx, row.ownerId, tenant);
    }, args.tenantId);
    // Reserva atómica: la factura pasa a `rectified` con la fila bloqueada y
    // comprobando que sigue sin cobros ni cobros en curso. Dos anulaciones a
    // la vez no emiten dos rectificativas.
    const original = await this.prisma.withTenant(async (tx) => {
      await lockInvoiceRow(tx, args.invoiceId);
      const fresh = await tx.invoice.findUniqueOrThrow({
        where: { id: args.invoiceId },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (fresh.status !== 'issued' && fresh.status !== 'overdue') {
        throw new BadRequestException({
          code: 'invoice_not_cancellable',
          message:
            fresh.status === 'rectified' || fresh.status === 'cancelled'
              ? 'La factura ya está anulada'
              : 'Una factura cobrada no se anula: reembólsala o emite una rectificativa',
        });
      }
      if (fresh.invoiceType !== 'F1' && fresh.invoiceType !== 'F2') {
        throw new BadRequestException({
          code: 'invoice_not_cancellable',
          message: 'Una rectificativa no se anula: emite otra rectificativa',
        });
      }
      // La retención de IRPF no es un cobro: no impide anular.
      if (isGreaterThan(subtractAmounts(fresh.amountPaid, fresh.withholdingAmount), 0)) {
        throw new BadRequestException({
          code: 'invoice_has_payments',
          message:
            'La factura tiene cobros: reembolsa lo cobrado o emite una rectificativa por la diferencia',
        });
      }
      const inFlight = await tx.payment.count({
        where: { invoiceId: args.invoiceId, status: { in: ['pending', 'processing'] } },
      });
      if (inFlight > 0) {
        throw new ConflictException({
          code: 'payment_in_progress',
          message: 'Hay un cobro en curso para esta factura: espera a que se resuelva',
        });
      }
      await assertNotInSepaRemittance(tx, args.invoiceId);
      await tx.invoice.update({
        where: { id: args.invoiceId },
        data: { status: 'rectified', cancelledAt: new Date() },
      });
      return fresh;
    }, args.tenantId);

    // Líneas en negativo: mismas cantidades y tipos de IVA, precio con signo
    // contrario → la rectificativa resta exactamente lo facturado.
    const items = original.items.map((it) => {
      const qty = Number(it.quantity);
      const integer = Number.isInteger(qty) && qty > 0;
      return {
        description: it.description,
        quantity: integer ? qty : 1,
        unitPrice: -(integer
          ? Number(it.unitPrice)
          : Math.round(qty * Number(it.unitPrice) * 100) / 100),
        taxRate: Number(it.taxRate),
        taxCategory: it.taxCategory as InvoiceTaxCategory,
        ...(it.relatedContractId ? { relatedContractId: it.relatedContractId } : {}),
        ...(it.relatedUnitId ? { relatedUnitId: it.relatedUnitId } : {}),
        ...(it.periodStart ? { periodStart: it.periodStart.toISOString().slice(0, 10) } : {}),
        ...(it.periodEnd ? { periodEnd: it.periodEnd.toISOString().slice(0, 10) } : {}),
      };
    });

    let rectificationId: string;
    try {
      const draft = await this.rectify({
        originalInvoiceId: original.id,
        tenantId: args.tenantId,
        userId: args.userId,
        input: {
          rectificationType: original.invoiceType === 'F2' ? 'R5' : 'R4',
          reason,
          correctionMethod: 'by_differences',
          items,
        },
        meta: args.meta,
        allowRectifiedOriginal: true,
      });
      rectificationId = draft.id;
    } catch (err) {
      // Sin rectificativa no hay anulación: la factura vuelve a su estado.
      await this.prisma.withTenant(
        (tx) =>
          tx.invoice.updateMany({
            where: { id: original.id, status: 'rectified' },
            data: { status: original.status, cancelledAt: null },
          }),
        args.tenantId,
      );
      throw err;
    }

    try {
      await this.issue({
        tenantId: args.tenantId,
        userId: args.userId,
        invoiceId: rectificationId,
        meta: args.meta,
      });
      // Compensada con la original (que no se cobró): no queda nada que
      // cobrar ni que devolver, así que no cuenta como pendiente ni vence.
      await this.prisma.withTenant(async (tx) => {
        const r = await tx.invoice.findUniqueOrThrow({
          where: { id: rectificationId },
          select: { total: true },
        });
        await tx.invoice.updateMany({
          where: { id: rectificationId, status: 'issued' },
          data: { status: 'paid', amountPaid: r.total, paidAt: new Date(), dueDate: null },
        });
      }, args.tenantId);
    } catch (err) {
      // La rectificativa queda en borrador enlazada a la original: el staff la
      // ve y la emite a mano. La original ya no se cobra.
      this.logger.error(
        `[invoices] rectificativa ${rectificationId} de ${original.id} sin emitir: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.cancelled_with_rectification',
      entityType: 'Invoice',
      entityId: original.id,
      changes: { reason, rectificationId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    await this.releaseConsumedBenefits(args.tenantId, original.id);
    await this.cancelOrphanLateFee(args, original.id, original.invoiceNumber);
    this.events.emit(DOMAIN_EVENTS.invoice_voided, {
      tenantId: args.tenantId,
      invoiceId: original.id,
    } satisfies InvoiceVoidedPayload);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findUniqueOrThrow({
          where: { id: original.id },
          include: this.includeRelations(),
        }),
      args.tenantId,
    );
    return this.toDto(updated);
  }

  /**
   * Anula una factura emitida por error: de prueba, duplicada o de una
   * operación que no existió (art. 11 del RRSIF; FAQ de la AEAT, n.º 17.2.d).
   * Se genera su registro de anulación (sin registro previo si la AEAT no la
   * tenía) y la factura queda `cancelled`, fuera de libros e informes.
   *
   * Es excepcional: si la operación existió, lo que toca es rectificar. Por eso
   * solo con una factura sin cobros, sin rectificar y que no sea rectificativa.
   */
  async void(args: {
    tenantId: string;
    userId: string | null;
    invoiceId: string;
    facilityScope?: string[] | null;
    input: VoidInvoiceInput;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    if (existing.kind === 'deposit_receipt') {
      throw new BadRequestException({
        code: 'not_an_invoice',
        message: 'Un justificante de fianza no es una factura: se anula con «Anular»',
      });
    }
    if (existing.issuedBy === 'holded') {
      throw new BadRequestException({
        code: 'issued_by_holded',
        message: 'Esta factura la emitió Holded: anúlala allí',
      });
    }
    const reason = args.input.reason.trim();
    const done = await this.prisma.withTenant(async (tx) => {
      await lockInvoiceRow(tx, args.invoiceId);
      const fresh = await tx.invoice.findUniqueOrThrow({
        where: { id: args.invoiceId },
        select: {
          status: true,
          invoiceType: true,
          amountPaid: true,
          withholdingAmount: true,
          ownerId: true,
          rectifiedBy: { where: { status: { not: 'cancelled' } }, select: { id: true } },
        },
      });
      if (fresh.status !== 'issued' && fresh.status !== 'overdue') {
        throw new BadRequestException({
          code: 'invoice_not_voidable',
          message:
            fresh.status === 'cancelled' || fresh.status === 'rectified'
              ? 'La factura ya está anulada'
              : fresh.status === 'draft'
                ? 'Un borrador no se anula así: cancélalo'
                : 'Una factura cobrada no se anula: si la operación no existió, devuelve el cobro y vuelve a intentarlo',
        });
      }
      if (fresh.invoiceType !== 'F1' && fresh.invoiceType !== 'F2') {
        throw new BadRequestException({
          code: 'invoice_not_voidable',
          message: 'Una rectificativa no se anula así: emite otra rectificativa',
        });
      }
      if (fresh.rectifiedBy.length > 0) {
        throw new BadRequestException({
          code: 'invoice_rectified',
          message: 'Esta factura tiene una rectificativa: lo que haya que corregir, con otra',
        });
      }
      // La retención de IRPF no es un cobro: no impide anular.
      if (isGreaterThan(subtractAmounts(fresh.amountPaid, fresh.withholdingAmount), 0)) {
        throw new BadRequestException({
          code: 'invoice_has_payments',
          message: 'La factura tiene cobros: devuélvelos antes de anularla',
        });
      }
      const inFlight = await tx.payment.count({
        where: { invoiceId: args.invoiceId, status: { in: ['pending', 'processing'] } },
      });
      if (inFlight > 0) {
        throw new ConflictException({
          code: 'payment_in_progress',
          message: 'Hay un cobro en curso para esta factura: espera a que se resuelva',
        });
      }
      await assertNotInSepaRemittance(tx, args.invoiceId);

      // Con Veri*Factu: el registro de anulación, encadenado como cualquier otro.
      const latest = await this.verifactuRecords.latest(tx, args.invoiceId);
      if (latest) {
        if (latest.status === 'pending' || latest.status === 'error') {
          throw new ConflictException({
            code: 'verifactu_record_pending',
            message:
              'La factura se está enviando a la AEAT: espera a que responda y vuelve a intentarlo',
          });
        }
        const registered =
          (await tx.verifactuRecord.count({
            where: {
              invoiceId: args.invoiceId,
              kind: 'alta',
              status: { in: ['accepted', 'accepted_with_warnings'] },
            },
          })) > 0;
        await this.verifactuRecords.createAnulacion(tx, {
          tenantId: args.tenantId,
          invoiceId: args.invoiceId,
          ownerId: fresh.ownerId,
          sinRegistroPrevio: !registered,
          reason,
          userId: args.userId,
        });
      }
      const now = new Date();
      await tx.invoice.update({
        where: { id: args.invoiceId },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          voidedAt: now,
          voidReason: reason,
          voidedByUserId: args.userId,
        },
      });
      if (latest) await this.verifactuRecords.syncInvoices(tx, [args.invoiceId]);
      return { record: Boolean(latest), ownerId: fresh.ownerId };
    }, args.tenantId);

    if (done.record) await this.verifactuDispatcher.schedule(args.tenantId, done.ownerId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'invoice.voided',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      changes: { reason, verifactu: done.record },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    await this.releaseConsumedBenefits(args.tenantId, args.invoiceId);
    await this.cancelOrphanLateFee(args, args.invoiceId, existing.invoiceNumber);
    // La copia de Holded se anula; el acceso cortado por esta deuda vuelve.
    this.events.emit(DOMAIN_EVENTS.invoice_cancelled, {
      tenantId: args.tenantId,
      invoiceId: args.invoiceId,
    } satisfies InvoiceCancelledPayload);
    this.events.emit(DOMAIN_EVENTS.invoice_voided, {
      tenantId: args.tenantId,
      invoiceId: args.invoiceId,
    } satisfies InvoiceVoidedPayload);
    // El PDF sale con la marca «Anulada».
    this.events.emit(INVOICE_PDF_REQUESTED, {
      tenantId: args.tenantId,
      invoiceId: args.invoiceId,
      refresh: true,
    } satisfies InvoicePdfRequestedPayload);
    return this.toDto(await this.findOrThrow(args.tenantId, args.invoiceId));
  }

  /**
   * Lo que gastó la factura al crearse vuelve al contrato: el mes gratis de una
   * promoción, el saldo a favor (señal) y la recompensa por recomendar. Una vez.
   */
  private async releaseConsumedBenefits(tenantId: string, invoiceId: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const row = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { contractId: true, consumedBenefits: true },
      });
      if (!row) return;
      const benefits = (row.consumedBenefits ?? null) as ConsumedBenefits | null;
      if (row.contractId && benefits) {
        const creditCents = benefits.creditCents ?? 0;
        await tx.contract.update({
          where: { id: row.contractId },
          data: {
            ...(benefits.freeMonth ? { freeMonthsRemaining: { increment: 1 } } : {}),
            ...(creditCents > 0
              ? {
                  pendingCreditAmount: { increment: creditCents / 100 },
                  ...(benefits.creditReason ? { pendingCreditReason: benefits.creditReason } : {}),
                }
              : {}),
          },
        });
      }
      if (benefits) {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { consumedBenefits: Prisma.DbNull },
        });
      }
      // La recompensa por recomendar vuelve a estar pendiente para la siguiente.
      await tx.referral.updateMany({
        where: { rewardInvoiceId: invoiceId },
        data: { rewardAppliedAt: null, rewardInvoiceId: null },
      });
    }, tenantId);
  }

  /** Anulada la factura, su recargo por mora sin cobrar deja de tener sentido. */
  private async cancelOrphanLateFee(
    args: { tenantId: string; userId: string | null; meta: RequestMeta },
    originalId: string,
    originalNumber: string,
  ): Promise<void> {
    const fee = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: {
            lateFeeForInvoiceId: originalId,
            status: { in: ['draft', 'issued', 'overdue'] },
            deletedAt: null,
          },
          select: { id: true, amountPaid: true },
        }),
      args.tenantId,
    );
    if (!fee || Number(fee.amountPaid) > 0) return;
    try {
      await this.cancel({
        tenantId: args.tenantId,
        userId: args.userId,
        invoiceId: fee.id,
        input: { reason: `Anulada la factura ${originalNumber}` },
        meta: args.meta,
      });
    } catch (err) {
      this.logger.warn(
        `[invoices] recargo ${fee.id} de ${originalId} sin anular: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Envío real a la AEAT: una factura completa o rectificativa necesita un
   * destinatario identificado (NIF español válido, o documento extranjero
   * con país). Una simplificada sin cliente no.
   */
  private async assertRecipientIdentifiable(
    tx: Prisma.TransactionClient,
    invoice: { invoiceType: string; customerId: string | null },
  ): Promise<void> {
    if (invoice.invoiceType === 'F2' && !invoice.customerId) return;
    if (!invoice.customerId) {
      throw new BadRequestException({
        code: 'customer_required',
        message: 'Una factura completa necesita un cliente identificado',
      });
    }
    const c = await tx.customer.findUnique({
      where: { id: invoice.customerId },
      select: { documentNumber: true, country: true },
    });
    const doc = (c?.documentNumber ?? '').trim();
    const spanish = (c?.country ?? 'ES').toUpperCase() === 'ES';
    if (!doc || (spanish && !isValidSpanishTaxId(doc))) {
      if (invoice.invoiceType === 'F2') return; // simplificada: el NIF es opcional
      throw new BadRequestException({
        code: 'customer_tax_id_required',
        message:
          'El cliente no tiene un NIF/NIE válido: complétalo en su ficha (o emite una factura simplificada si no supera 400 €)',
      });
    }
  }

  /** Marca una factura como pagada manualmente (cobro en efectivo, transferencia...). */
  async markPaidManually(args: {
    tenantId: string;
    userId: string | null;
    invoiceId: string;
    facilityScope?: string[] | null;
    input: MarkPaidManuallyInput;
    meta: RequestMeta;
    /**
     * Registro a mano desde el panel: el mismo cobro dos veces en unos segundos
     * es un doble clic (409), no dos cobros.
     */
    rejectDuplicate?: boolean;
  }): Promise<InvoiceDto> {
    // Alcance por local y existencia (fuera de la transacción: solo lectura).
    const existing = await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    const amount = args.input.amount;
    const paidAt = args.input.paidAt ? new Date(args.input.paidAt) : new Date();
    // Un cobro no se registra en el futuro (unos minutos de margen por el reloj).
    if (paidAt.getTime() > Date.now() + 10 * 60_000) {
      throw new BadRequestException({
        code: 'paid_at_in_future',
        message: 'La fecha del cobro no puede ser futura',
      });
    }
    let total = 0;
    let fullyPaid = false;

    // Todas las comprobaciones de importe se hacen DENTRO de la transacción,
    // sobre la fila bloqueada: dos cobros a la vez (Redsys + el staff, remesa SEPA
    // + conciliación N43…) se serializan y el segundo ve lo que ya cobró el
    // primero, en vez de calcular con una lectura vieja (dos pagos registrados y
    // el «pagado» sumado de menos, o un sobrecobro que pasa el control).
    const updated = await this.prisma.withTenant(async (tx) => {
      await lockInvoiceRow(tx, args.invoiceId);
      const fresh = await tx.invoice.findUniqueOrThrow({
        where: { id: args.invoiceId },
        select: { status: true, total: true, amountPaid: true, customerId: true },
      });
      if (fresh.status !== 'issued' && fresh.status !== 'overdue') {
        throw new BadRequestException({
          code: 'invoice_not_payable',
          message: 'La factura no esta en estado pagable',
        });
      }
      total = Number(fresh.total);
      const newPaid = addAmounts(fresh.amountPaid, amount);
      if (isGreaterThan(newPaid, total)) {
        throw new BadRequestException({
          code: 'overpayment',
          message: 'El importe excede el pendiente',
        });
      }
      fullyPaid = isAtLeast(newPaid, total);
      if (args.rejectDuplicate) {
        const twin = await tx.payment.findFirst({
          where: {
            invoiceId: args.invoiceId,
            gateway: 'manual',
            status: 'succeeded',
            amount,
            methodType: args.input.methodType,
            createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
          },
          select: { id: true },
        });
        if (twin) {
          throw new ConflictException({
            code: 'duplicate_payment',
            message:
              'Este cobro ya se ha registrado hace un momento. Si es otro, espera unos segundos.',
          });
        }
      }
      // Anti-doble-cobro: si hay un adeudo SEPA/tarjeta en curso (`processing`/
      // `pending`) sobre la factura, marcar pagado a mano lo cobraría dos veces
      // (el webhook confirmará el adeudo después). Se bloquea salvo marca explícita.
      if (!args.input.overridePaymentInFlight) {
        const gatewayInFlight = await tx.payment.count({
          where: {
            invoiceId: args.invoiceId,
            // También Redsys: un cobro con tarjeta guardada sin respuesta del
            // banco puede acabar cobrado (lo confirma su notificación).
            gateway: { in: ['stripe', 'gocardless', 'redsys'] },
            status: { in: ['pending', 'processing'] },
          },
        });
        if (gatewayInFlight > 0) {
          throw new ConflictException({
            code: 'gateway_payment_in_progress',
            message:
              'Hay un adeudo SEPA/tarjeta en curso para esta factura. Confirma "pagar de otra forma" para registrar el cobro manual.',
          });
        }
      }
      if (!args.input.allowInSepaRemittance) {
        await assertNotInSepaRemittance(tx, args.invoiceId);
      }
      // Pagos parciales solo en efectivo: por cualquier otra vía la factura se
      // salda de una vez (evita cobros parciales fantasma por pasarela/transferencia).
      // Excepción: cobros bancarios reales ya confirmados (N43/SEPA) con `allowPartialNonCash`.
      if (
        isGreaterThan(total, newPaid) &&
        args.input.methodType !== 'cash' &&
        !args.input.allowPartialNonCash
      ) {
        throw new BadRequestException({
          code: 'partial_only_cash',
          message:
            'Solo se admiten pagos parciales en efectivo; por otra vía debe saldarse el total',
        });
      }
      // También en una F2 sin destinatario (pago sin cliente): así cuenta en
      // lo cobrado y en el cierre de caja.
      await tx.payment.create({
        data: {
          tenantId: args.tenantId,
          invoiceId: args.invoiceId,
          customerId: fresh.customerId ?? null,
          amount,
          methodType: args.input.methodType,
          gateway: 'manual',
          status: 'succeeded',
          paidAt,
          notes: args.input.notes?.trim() || null,
        },
      });
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
    facilityScope?: string[] | null;
    /** Revertir exactamente este cobro (si no, se elige por importe). */
    paymentId?: string;
    /**
     * Deshacer un cobro registrado por error (p. ej. una conciliación
     * automática): no cuenta como recibo devuelto.
     */
    undo?: boolean;
    meta: RequestMeta;
  }): Promise<InvoiceDto> {
    await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    let revertedStatus: InvoiceStatus = 'issued';
    let backToOverdue = false;
    let revertedIds: string[] = [];

    const updated = await this.prisma.withTenant(async (tx) => {
      // Fila bloqueada + lectura fresca: dos devoluciones a la vez no restan
      // dos veces sobre el mismo «pagado».
      await lockInvoiceRow(tx, args.invoiceId);
      const existing = await tx.invoice.findUniqueOrThrow({
        where: { id: args.invoiceId },
        select: { amountPaid: true, status: true, dueDate: true },
      });
      if (Number(existing.amountPaid) <= 0) {
        throw new BadRequestException({
          code: 'nothing_to_revert',
          message: 'La factura no tiene cobros que revertir',
        });
      }
      const newPaid = Math.max(0, subtractAmounts(existing.amountPaid, args.amount));
      const wasPaid = existing.status === 'paid';
      revertedStatus = wasPaid
        ? existing.dueDate && existing.dueDate.getTime() < Date.now()
          ? 'overdue'
          : 'issued'
        : existing.status;
      // Pagada → vencida otra vez (no al deshacer un cobro registrado por error).
      backToOverdue = wasPaid && revertedStatus === 'overdue' && !args.undo;
      // Solo el cobro devuelto pasa a fallido (antes, todos los de la
      // factura): primero uno del mismo importe; si no, los más recientes
      // que quepan en lo devuelto.
      const live = await tx.payment.findMany({
        where: {
          invoiceId: args.invoiceId,
          status: 'succeeded',
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
        },
        orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
        select: { id: true, amount: true },
      });
      const target = toCents(args.amount);
      const exact = args.paymentId
        ? live.find((p) => p.id === args.paymentId)
        : live.find((p) => toCents(p.amount) === target);
      if (args.paymentId && !exact) {
        throw new BadRequestException({
          code: 'payment_not_found',
          message: 'Ese cobro ya no está en la factura',
        });
      }
      const reverted: string[] = [];
      if (exact) {
        reverted.push(exact.id);
      } else {
        let left = target;
        for (const p of live) {
          const cents = toCents(p.amount);
          if (cents > left) continue;
          reverted.push(p.id);
          left -= cents;
          if (left <= 0) break;
        }
      }
      revertedIds = reverted;
      if (reverted.length > 0) {
        await tx.payment.updateMany({
          where: { id: { in: reverted } },
          data: {
            status: 'failed',
            failureReason: args.reason,
            ...(args.undo ? {} : { returnedAt: new Date() }),
          },
        });
      }
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
      action: args.undo ? 'invoice.payment_undone' : 'invoice.payment_reverted',
      entityType: 'Invoice',
      entityId: args.invoiceId,
      // Qué cobros: la ficha marca así los deshechos.
      changes: {
        amount: args.amount,
        reason: args.reason,
        revertedStatus,
        paymentIds: revertedIds,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    // Cobro devuelto: el escalado de impagos empieza de cero desde hoy.
    if (backToOverdue) {
      this.events.emit(DOMAIN_EVENTS.invoice_payment_reverted, {
        tenantId: args.tenantId,
        invoiceId: args.invoiceId,
      } satisfies InvoicePaymentRevertedPayload);
    }
    return this.toDto(updated);
  }

  async refund(args: {
    tenantId: string;
    /** null en los reembolsos automáticos (p. ej. suscripción devuelta en Stripe). */
    userId: string | null;
    invoiceId: string;
    facilityScope?: string[] | null;
    input: RefundInvoiceInput;
    meta: RequestMeta;
    /**
     * Uso interno: permite devolver un justificante de fianza (cancelación de
     * una reserva antes de la apertura). Desde el panel la fianza se devuelve
     * al liquidarla.
     */
    allowDepositReceipt?: boolean;
    /** Desde el panel: la misma devolución dos veces en unos segundos es un doble clic. */
    rejectDuplicate?: boolean;
  }): Promise<InvoiceDto> {
    // Alcance por local y existencia (fuera de la transacción: solo lectura).
    await this.findOrThrow(args.tenantId, args.invoiceId, args.facilityScope);
    const amount = args.input.amount;
    let fullyRefunded = false;
    let gatewayRefundId: string | null = null;
    let usedGateway = false;

    // Todo el reembolso va en UNA transacción con la factura bloqueada, que
    // incluye la llamada a la pasarela: un doble clic (o dos personas a la vez)
    // espera al primero y ve lo ya reembolsado, en vez de devolver el dinero dos
    // veces. La clave de idempotencia cubre además un reintento tras un fallo de
    // red: la pasarela devuelve el mismo reembolso en vez de crear otro. Si la
    // pasarela devuelve el dinero pero el commit fallara, el webhook
    // `charge.refunded` lo sincroniza por delta.
    const updated = await this.prisma.withTenant(
      async (tx) => {
        await lockInvoiceRow(tx, args.invoiceId);
        const existing = await tx.invoice.findUniqueOrThrow({
          where: { id: args.invoiceId },
          select: { status: true, total: true, amountRefunded: true, kind: true, contractId: true },
        });
        if (existing.kind === 'deposit_receipt' && !args.allowDepositReceipt) {
          throw new BadRequestException({
            code: 'invoice_not_refundable',
            message: 'La fianza se devuelve al liquidarla desde el contrato',
          });
        }
        if (existing.status !== 'paid' && existing.status !== 'partially_refunded') {
          throw new BadRequestException({
            code: 'invoice_not_refundable',
            message: 'Solo se pueden reembolsar facturas pagadas',
          });
        }
        const total = Number(existing.total);
        const newRefunded = addAmounts(existing.amountRefunded, amount);
        // Se devuelve, como mucho, el dinero realmente cobrado (una
        // compensación con un abono no es dinero que devolver).
        const realPayments = await tx.payment.findMany({
          where: {
            invoiceId: args.invoiceId,
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          select: { amount: true },
        });
        const collectedCents = realPayments.reduce((sum, p) => sum + toCents(p.amount), 0);
        if (isGreaterThan(newRefunded, total) || toCents(newRefunded) > collectedCents) {
          throw new BadRequestException({
            code: 'over_refund',
            message: 'El importe excede el cobrado',
          });
        }
        fullyRefunded = isAtLeast(newRefunded, total);
        if (args.rejectDuplicate) {
          const twin = await tx.invoiceRefund.findFirst({
            where: {
              invoiceId: args.invoiceId,
              amount,
              createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
            },
            select: { id: true },
          });
          if (twin) {
            throw new ConflictException({
              code: 'duplicate_refund',
              message:
                'Esta devolución ya se ha registrado hace un momento. Si es otra, espera unos segundos.',
            });
          }
        }

        // Si la factura se cobró por pasarela (Stripe/SEPA), devolvemos el dinero
        // DE VERDAD: el payment con `gatewayPaymentId` que tenga saldo reembolsable.
        const gatewayPayment = await tx.payment.findFirst({
          where: {
            invoiceId: args.invoiceId,
            gatewayPaymentId: { not: null },
            status: { in: ['succeeded', 'partially_refunded'] },
          },
          orderBy: { createdAt: 'desc' },
        });

        let via: 'gateway' | 'bank' | 'manual' | 'credit' = 'manual';
        let refundedPaymentId: string | null = null;
        if (args.input.method === 'credit') {
          // Saldo a favor: no sale dinero; su próxima factura lo descuenta.
          if (!existing.contractId) {
            throw new BadRequestException({
              code: 'credit_needs_contract',
              message: 'Solo se puede dejar como saldo a favor si la factura es de un contrato',
            });
          }
          await tx.contract.update({
            where: { id: existing.contractId },
            data: { creditBalance: { increment: amount } },
          });
          via = 'credit';
        } else if (
          gatewayPayment?.gatewayPaymentId &&
          gatewayPayment.gateway !== 'stripe' &&
          gatewayPayment.gateway !== 'gocardless'
        ) {
          // Redsys (tarjeta guardada): la app no puede devolver el dinero. Se
          // devuelve en el banco o en el panel del TPV y aquí se registra.
          if (!args.input.registeredExternally) {
            throw new BadRequestException({
              code: 'refund_needs_bank',
              message:
                'Este cobro se hizo con el TPV del banco: devuélvelo allí y después regístralo aquí.',
            });
          }
          const refundable = subtractAmounts(gatewayPayment.amount, gatewayPayment.refundedAmount);
          if (isGreaterThan(amount, refundable)) {
            throw new BadRequestException({
              code: 'over_refund_gateway',
              message: 'El importe excede lo cobrado en ese pago',
            });
          }
          const newPaymentRefunded = addAmounts(gatewayPayment.refundedAmount, amount);
          await tx.payment.update({
            where: { id: gatewayPayment.id },
            data: {
              refundedAmount: newPaymentRefunded,
              refundedAt: new Date(),
              status: isAtLeast(newPaymentRefunded, gatewayPayment.amount)
                ? 'refunded'
                : 'partially_refunded',
            },
          });
          via = 'bank';
          refundedPaymentId = gatewayPayment.id;
        } else if (gatewayPayment?.gatewayPaymentId) {
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
          const newPaymentRefunded = addAmounts(gatewayPayment.refundedAmount, amount);
          // Misma clave para el mismo reembolso del mismo pago (lo ya devuelto +
          // este importe): un reintento idéntico no crea un segundo reembolso.
          const idempotencyKey = `refund-${gatewayPayment.id}-${toCents(newPaymentRefunded)}`;
          // GoCardless usa su propia API (SEPA, reembolso asíncrono); el resto
          // (Stripe) va por el `PAYMENT_GATEWAY` inyectado.
          const result =
            gatewayPayment.gateway === 'gocardless'
              ? await this.goCardlessCharge.refund({
                  tenantId: args.tenantId,
                  paymentId: gatewayPayment.gatewayPaymentId,
                  amountCents: toCents(amount),
                  // Suma total reembolsada del payment (incluido este) para la
                  // salvaguarda `total_amount_confirmation` de GoCardless.
                  totalAmountConfirmationCents: toCents(newPaymentRefunded),
                  idempotencyKey,
                  ...(args.input.reason ? { reason: args.input.reason } : {}),
                })
              : await this.gateway.refund({
                  gatewayPaymentId: gatewayPayment.gatewayPaymentId,
                  amountCents: toCents(amount),
                  idempotencyKey,
                  ...(args.input.reason ? { reason: args.input.reason } : {}),
                  // Stripe Connect: el cobro está en la cuenta del tenant.
                  ...(gatewayPayment.stripeAccountId
                    ? { stripeAccount: gatewayPayment.stripeAccountId }
                    : {}),
                });
          if (result.status === 'failed') {
            throw new BadRequestException({
              code: 'gateway_refund_failed',
              message: 'La pasarela rechazó el reembolso; no se ha devuelto el dinero',
            });
          }
          gatewayRefundId = result.gatewayRefundId;
          usedGateway = true;
          via = 'gateway';
          refundedPaymentId = gatewayPayment.id;
          // `payment.refundedAmount` al día: el webhook `charge.refunded`
          // sincroniza por delta contra este campo, así no se cuenta dos veces.
          await tx.payment.update({
            where: { id: gatewayPayment.id },
            data: {
              refundedAmount: newPaymentRefunded,
              refundedAt: new Date(),
              status: isAtLeast(newPaymentRefunded, gatewayPayment.amount)
                ? 'refunded'
                : 'partially_refunded',
            },
          });
        } else {
          // Cobro manual (efectivo/transferencia): no hay pasarela que devuelva el
          // dinero, pero registramos el reembolso en el `payment` para que el arqueo
          // de caja lo descuente por su método (p. ej. una devolución en efectivo).
          const manualPayment = await tx.payment.findFirst({
            where: {
              invoiceId: args.invoiceId,
              gatewayPaymentId: null,
              status: { in: ['succeeded', 'partially_refunded'] },
              methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (manualPayment) {
            const newPaymentRefunded = addAmounts(manualPayment.refundedAmount, amount);
            await tx.payment.update({
              where: { id: manualPayment.id },
              data: {
                refundedAmount: newPaymentRefunded,
                refundedAt: new Date(),
                status: isAtLeast(newPaymentRefunded, manualPayment.amount)
                  ? 'refunded'
                  : 'partially_refunded',
              },
            });
            refundedPaymentId = manualPayment.id;
          }
        }
        // Constancia de cada devolución: cuánto, cómo y quién.
        await tx.invoiceRefund.create({
          data: {
            tenantId: args.tenantId,
            invoiceId: args.invoiceId,
            paymentId: refundedPaymentId,
            amount,
            via,
            reason: args.input.reason?.trim() || null,
            gatewayRefundId,
            createdByUserId: args.userId,
          },
        });
        return tx.invoice.update({
          where: { id: args.invoiceId },
          data: {
            amountRefunded: newRefunded,
            status: fullyRefunded ? 'refunded' : 'partially_refunded',
          },
          include: this.includeRelations(),
        });
      },
      args.tenantId,
      // Incluye la llamada a la pasarela.
      { timeout: 30_000 },
    );

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
        gateway: usedGateway,
        gatewayRefundId,
        method: args.input.method ?? 'original',
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    // Dinero devuelto → rectificativa de abono por lo devuelto (si no, el IVA
    // de lo reembolsado se seguía declarando).
    this.events.emit(DOMAIN_EVENTS.invoice_refunded, {
      tenantId: args.tenantId,
      invoiceId: args.invoiceId,
      amount,
    } satisfies InvoiceRefundedPayload);
    return this.toDto(updated);
  }

  @OnEvent(DOMAIN_EVENTS.invoice_refunded, { async: true, promisify: true })
  async onInvoiceRefunded(p: InvoiceRefundedPayload): Promise<void> {
    try {
      await this.issueRefundCreditNote(p.tenantId, p.invoiceId, p.amount);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`[invoices] abono por reembolso de ${p.invoiceId} sin emitir: ${reason}`);
      // El dinero ya se devolvió: sin la rectificativa los libros no cuadran.
      // Se avisa al equipo para que la emita (o lo resuelva) desde la factura.
      await this.prisma
        .withTenant(
          (tx) =>
            tx.notification.create({
              data: {
                tenantId: p.tenantId,
                type: 'invoice.refund_credit_note_failed',
                title: 'Falta la rectificativa de un reembolso',
                body: `Se devolvieron ${p.amount.toFixed(2)} € de una factura pero no se pudo emitir su rectificativa de abono: ${reason.slice(0, 300)}. Revísala en la factura.`,
                link: `/invoices/${p.invoiceId}`,
              },
            }),
          p.tenantId,
        )
        .catch(() => undefined);
    }
  }

  /**
   * Rectificativa de abono (por diferencias) por un importe devuelto,
   * repartido por tipo de IVA en proporción a la factura. Se emite y queda
   * compensada (el dinero ya se devolvió por el reembolso).
   */
  async issueRefundCreditNote(tenantId: string, invoiceId: string, amount: number): Promise<void> {
    const original = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: invoiceId, deletedAt: null },
          include: { items: true },
        }),
      tenantId,
    );
    if (!original || original.kind !== 'invoice') return;
    if (original.invoiceType !== 'F1' && original.invoiceType !== 'F2') return;
    const totalCents = toCents(original.total);
    // Abono necesario = lo devuelto en total − lo que ya cubren los abonos
    // emitidos que no compensaron un pendiente (p. ej. el abono de la baja de
    // un prepago emitido antes del reembolso): sin esto, reembolsar después de
    // un abono manual generaba un segundo abono por el mismo dinero.
    const [credits, compensations] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.invoice.findMany({
            where: {
              rectifiesInvoiceId: invoiceId,
              correctionMethod: 'by_differences',
              sequenceNumber: { gt: 0 },
              deletedAt: null,
            },
            select: { total: true },
          }),
          tx.payment.findMany({
            where: { invoiceId, methodType: 'credit_note', status: 'succeeded' },
            select: { amount: true },
          }),
        ]),
      tenantId,
    );
    const creditedCents = credits.reduce((sum, c) => sum - Math.min(0, toCents(c.total)), 0);
    const compensatedCents = compensations.reduce((sum, c) => sum + toCents(c.amount), 0);
    const coveredCents = Math.max(0, creditedCents - compensatedCents);
    const refundCents = Math.min(toCents(original.amountRefunded), totalCents) - coveredCents;
    if (refundCents <= 0 || totalCents <= 0) return;
    void amount; // el importe del aviso solo informa: se recalcula sobre lo acumulado

    // Bruto por tipo de IVA y parte proporcional del reembolso.
    // Agrupado por tipo y por tipo fiscal (una línea exenta y otra no sujeta,
    // ambas al 0 %, se abonan por separado).
    const grossByRate = new Map<string, number>();
    for (const it of original.items) {
      const key = `${Number(it.taxRate)}|${it.taxCategory}`;
      grossByRate.set(key, (grossByRate.get(key) ?? 0) + toCents(it.total));
    }
    const rates = [...grossByRate.entries()]
      .filter(([, g]) => g > 0)
      .map(([key, gross]) => {
        const [rate, category] = key.split('|') as [string, InvoiceTaxCategory];
        return [Number(rate), gross, category] as const;
      })
      .sort(([a], [b]) => b - a);
    let assigned = 0;
    const items = rates.map(([rate, gross, category], idx) => {
      const share =
        idx === rates.length - 1
          ? refundCents - assigned
          : Math.round((refundCents * gross) / totalCents);
      assigned += share;
      // Base tal que base + cuota (redondeada por línea) = lo devuelto.
      let netCents = Math.round(share / (1 + rate / 100));
      const tax = Math.round((netCents * rate) / 100);
      netCents += share - (netCents + tax);
      return {
        description: `Abono por reembolso de la factura ${original.invoiceNumber}`,
        quantity: 1,
        unitPrice: -netCents / 100,
        taxRate: rate,
        taxCategory: category,
      };
    });

    // Un abono de un reembolso anterior que no se llegó a emitir se sustituye
    // por este (que ya cubre todo lo devuelto): si no, contaría dos veces en el
    // límite de lo que se puede abonar.
    await this.prisma.withTenant(
      (tx) =>
        tx.invoice.updateMany({
          where: {
            rectifiesInvoiceId: invoiceId,
            status: 'draft',
            rectificationReason: REFUND_CREDIT_REASON,
            deletedAt: null,
          },
          data: { status: 'cancelled' },
        }),
      tenantId,
    );
    const draft = await this.rectify({
      originalInvoiceId: original.id,
      tenantId,
      userId: null,
      input: {
        rectificationType: original.invoiceType === 'F2' ? 'R5' : 'R4',
        reason: REFUND_CREDIT_REASON,
        correctionMethod: 'by_differences',
        items,
      },
      meta: {},
      allowRectifiedOriginal: true,
    });
    await this.issue({ tenantId, userId: null, invoiceId: draft.id, meta: {} });
    // Compensada: el dinero ya se devolvió.
    await this.prisma.withTenant(async (tx) => {
      const r = await tx.invoice.findUniqueOrThrow({
        where: { id: draft.id },
        select: { total: true },
      });
      await tx.invoice.updateMany({
        where: { id: draft.id, status: 'issued' },
        data: { status: 'paid', amountPaid: r.total, paidAt: new Date(), dueDate: null },
      });
    }, tenantId);
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
    facilityScope?: string[] | null;
    userId: string | null;
    input: RectifyInvoiceInput;
    meta: RequestMeta;
    /** Uso interno de la anulación: la original ya está reservada como `rectified`. */
    allowRectifiedOriginal?: boolean;
  }): Promise<InvoiceDto> {
    const original = await this.findOrThrow(
      args.tenantId,
      args.originalInvoiceId,
      args.facilityScope,
    );

    if (original.kind === 'deposit_receipt') {
      throw new BadRequestException({
        code: 'invoice_not_rectifiable',
        message: 'Un justificante de fianza no es una factura: no se rectifica',
      });
    }
    if (original.status === 'draft' || original.status === 'cancelled') {
      throw new BadRequestException({
        code: 'invoice_not_rectifiable',
        message: 'Solo se pueden rectificar facturas emitidas',
      });
    }
    if (original.status === 'rectified' && !args.allowRectifiedOriginal) {
      throw new BadRequestException({
        code: 'invoice_not_rectifiable',
        message: 'La factura ya está anulada con una rectificativa por el total',
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
    const placeholderNumber = draftPlaceholderNumber();

    const created = await this.prisma.withTenant(async (tx) => {
      await this.assertRectificationLimits(tx, {
        originalId: original.id,
        selfId: null,
        total,
        method: correctionMethod,
      });
      // Serie propia de rectificativas (RD 1619/2012, art. 6).
      // (Del mismo emisor que la original: un propietario rectifica en la suya.)
      const rectSeries = await this.series.rectificationSeries(tx, args.tenantId, original.ownerId);
      return tx.invoice.create({
        data: {
          tenantId: args.tenantId,
          ...(original.ownerId ? { ownerId: original.ownerId } : {}),
          ...(original.customerId ? { customerId: original.customerId } : {}),
          ...(original.contractId ? { contractId: original.contractId } : {}),
          seriesId: rectSeries.id,
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
      });
    }, args.tenantId);

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

  /**
   * Compensa el pendiente de una factura con un abono: registra un pago de
   * compensación (`credit_note`, no es dinero cobrado) por lo que quede
   * pendiente, como mucho el abono. Con la fila bloqueada.
   */
  private async compensateWithCredit(
    tx: Prisma.TransactionClient,
    args: { tenantId: string; originalId: string; creditCents: number; creditNumber: string },
  ): Promise<{
    id: string;
    invoiceNumber: string;
    customerId: string | null;
    total: number;
    fullyPaid: boolean;
  } | null> {
    await lockInvoiceRow(tx, args.originalId);
    const orig = await tx.invoice.findUniqueOrThrow({
      where: { id: args.originalId },
      select: {
        status: true,
        total: true,
        amountPaid: true,
        customerId: true,
        invoiceNumber: true,
      },
    });
    if (orig.status !== 'issued' && orig.status !== 'overdue') return null;
    const pendingCents = toCents(orig.total) - toCents(orig.amountPaid);
    const comp = Math.min(pendingCents, args.creditCents);
    if (comp <= 0) return null;
    const now = new Date();
    await tx.payment.create({
      data: {
        tenantId: args.tenantId,
        invoiceId: args.originalId,
        customerId: orig.customerId,
        amount: comp / 100,
        methodType: 'credit_note',
        gateway: 'manual',
        status: 'succeeded',
        paidAt: now,
        notes: `Compensación con la rectificativa ${args.creditNumber}`,
      },
    });
    const newPaidCents = toCents(orig.amountPaid) + comp;
    const fullyPaid = newPaidCents >= toCents(orig.total);
    await tx.invoice.update({
      where: { id: args.originalId },
      data: {
        amountPaid: newPaidCents / 100,
        ...(fullyPaid ? { status: 'paid', paidAt: now } : {}),
      },
    });
    return {
      id: args.originalId,
      invoiceNumber: orig.invoiceNumber,
      customerId: orig.customerId,
      total: Number(orig.total),
      fullyPaid,
    };
  }

  /**
   * Límites de las rectificativas de una factura (con la original bloqueada):
   * - por sustitución: solo una, y solo si la original no tiene cobros (la
   *   sustitutiva pasa a ser la que se cobra);
   * - por diferencias: los abonos no pueden dejar la factura en negativo
   *   (original + Σ diferencias ≥ 0).
   */
  private async assertRectificationLimits(
    tx: Prisma.TransactionClient,
    args: {
      originalId: string;
      selfId: string | null;
      total: number;
      method: CorrectionMethodValue;
    },
  ): Promise<void> {
    await lockInvoiceRow(tx, args.originalId);
    const original = await tx.invoice.findUniqueOrThrow({
      where: { id: args.originalId },
      select: { total: true, amountPaid: true, withholdingAmount: true },
    });
    const others = await tx.invoice.findMany({
      where: {
        rectifiesInvoiceId: args.originalId,
        status: { not: 'cancelled' },
        deletedAt: null,
        ...(args.selfId ? { id: { not: args.selfId } } : {}),
      },
      select: { total: true, correctionMethod: true },
    });
    if (args.method === 'by_substitution') {
      // La retención de IRPF no es un cobro: con ella también se puede sustituir.
      if (toCents(original.amountPaid) - toCents(original.withholdingAmount) > 0) {
        throw new BadRequestException({
          code: 'substitution_original_paid',
          message:
            'La factura tiene cobros: corrígela con una rectificativa por diferencias, no por sustitución',
        });
      }
      if (others.length > 0) {
        throw new ConflictException({
          code: 'rectification_already_exists',
          message: 'La factura ya tiene rectificativas: no se puede sustituir',
        });
      }
      return;
    }
    if (others.some((o) => o.correctionMethod === 'by_substitution')) {
      throw new ConflictException({
        code: 'invoice_substituted',
        message: 'La factura ya está sustituida: rectifica la sustitutiva',
      });
    }
    const netCents =
      toCents(original.total) +
      others.reduce((sum, o) => sum + toCents(o.total), 0) +
      toCents(args.total);
    if (netCents < 0) {
      throw new BadRequestException({
        code: 'rectification_exceeds_original',
        message: 'Los abonos no pueden superar el total de la factura',
      });
    }
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

  private async findOrThrow(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<InvoiceWithRelations> {
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
    // Alcance por local: un usuario restringido no puede ver ni mutar por id una
    // factura de un contrato de un local fuera de su scope. Las facturas sin
    // contrato (F2/ventas de producto, sin local) se permiten.
    const facilityId = row.contract?.unit?.facility?.id;
    if (facilityId) assertFacilityAllowed(facilityScope, facilityId);
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
      owner: { select: { legalName: true } },
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
          offlinePaymentMethod: true,
          unit: {
            select: { id: true, code: true, facility: { select: { id: true, name: true } } },
          },
        },
      },
      series: { select: { code: true } },
      rectifiesInvoice: { select: { id: true, invoiceNumber: true, issueDate: true } },
      // Solo las compensaciones con un abono: lo saldado sin cobrar.
      payments: {
        where: { methodType: 'credit_note' as const, status: 'succeeded' as const },
        select: { amount: true },
      },
      rectifiedBy: {
        where: { deletedAt: null },
        select: { id: true, invoiceNumber: true, status: true, total: true },
        orderBy: { createdAt: 'asc' },
      },
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
      const line = lineCents(it.quantity, it.unitPrice, it.taxRate);
      taxCents += line.taxCents;
      totalCents += line.totalCents;
    }
    assertTotalInRange(totalCents);
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
    const line = lineCents(item.quantity, item.unitPrice, item.taxRate);
    return {
      tenantId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
      taxCategory: lineTaxCategory(item.taxRate, item.taxCategory),
      taxAmount: line.taxCents / 100,
      total: line.totalCents / 100,
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
      const line = lineCents(it.quantity, it.unitPrice, it.taxRate);
      taxCents += line.taxCents;
      totalCents += line.totalCents;
    }
    assertTotalInRange(totalCents);
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
    const line = lineCents(item.quantity, item.unitPrice, item.taxRate);
    return {
      tenantId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
      taxCategory: lineTaxCategory(item.taxRate, item.taxCategory),
      taxAmount: line.taxCents / 100,
      total: line.totalCents / 100,
      ...(item.relatedContractId ? { relatedContractId: item.relatedContractId } : {}),
      ...(item.relatedUnitId ? { relatedUnitId: item.relatedUnitId } : {}),
      ...(item.periodStart ? { periodStart: new Date(item.periodStart) } : {}),
      ...(item.periodEnd ? { periodEnd: new Date(item.periodEnd) } : {}),
      position,
    };
  }

  /** Vencimiento: los días de plazo del negocio desde la emisión (15 por defecto). */
  private computeDefaultDueDate(issueDate: Date, days = 15): Date {
    const due = new Date(issueDate);
    // UTC como el resto de fechas de facturación (setDate usa la TZ local del
    // servidor y podía mover el vencimiento un día según la hora de emisión).
    due.setUTCDate(due.getUTCDate() + days);
    return due;
  }

  /**
   * Una factura sin NIF, razón social y domicilio del emisor no es válida
   * (RD 1619/2012, art. 6). Del negocio, o del propietario que la emite.
   */
  private async assertIssuerFiscalData(
    tx: Prisma.TransactionClient,
    ownerId: string | null,
    tenant: {
      taxId: string | null;
      billingLegalName: string | null;
      billingAddress: string | null;
      billingPostalCode: string | null;
      billingCity: string | null;
    },
  ): Promise<void> {
    if (ownerId) {
      const owner = await tx.owner.findUnique({
        where: { id: ownerId },
        select: { legalName: true, taxId: true, address: true, postalCode: true, city: true },
      });
      const missing = owner
        ? tenantFiscalDataMissing({
            taxId: owner.taxId,
            billingLegalName: owner.legalName,
            billingAddress: owner.address,
            billingPostalCode: owner.postalCode,
            billingCity: owner.city,
          })
        : [];
      if (owner && missing.length) {
        throw new BadRequestException({
          code: 'issuer_fiscal_data_required',
          message: `Faltan datos del propietario ${owner.legalName} (${missing.join(', ')}). Complétalos en Propietarios antes de emitir sus facturas.`,
          details: { missing, ownerId },
        });
      }
      return;
    }
    const missing = tenantFiscalDataMissing(tenant);
    if (missing.length) {
      throw new BadRequestException({
        code: 'issuer_fiscal_data_required',
        message: `Antes de emitir facturas, completa los datos de tu empresa (falta: ${missing.join(', ')}) en Configuración → Datos de tu empresa.`,
        details: { missing },
      });
    }
  }

  /**
   * Saldo a favor del inquilino (una devolución que se dejó para su próxima
   * factura): al emitir una factura de su contrato, paga lo que alcance. Es una
   * compensación, no dinero cobrado (pago `credit_note`). Si la cubre entera,
   * queda pagada.
   */
  private async applyCreditBalance<
    T extends {
      id: string;
      contractId: string | null;
      customerId: string | null;
      invoiceType: string;
      kind: string;
      total: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
    },
  >(tx: Prisma.TransactionClient, tenantId: string, row: T): Promise<T> {
    if (!row.contractId || row.kind !== 'invoice' || row.invoiceType.startsWith('R')) return row;
    const contract = await tx.contract.findUnique({
      where: { id: row.contractId },
      select: { creditBalance: true },
    });
    const balanceCents = toCents(contract?.creditBalance ?? 0);
    const pendingCents = toCents(row.total) - toCents(row.amountPaid);
    if (balanceCents <= 0 || pendingCents <= 0) return row;
    const use = Math.min(balanceCents, pendingCents) / 100;
    // Condicionado al saldo: dos emisiones a la vez no lo gastan dos veces.
    const taken = await tx.contract.updateMany({
      where: { id: row.contractId, creditBalance: { gte: use } },
      data: { creditBalance: { decrement: use } },
    });
    if (taken.count === 0) return row;
    const now = new Date();
    await tx.payment.create({
      data: {
        tenantId,
        invoiceId: row.id,
        customerId: row.customerId,
        amount: use,
        status: 'succeeded',
        methodType: 'credit_note',
        gateway: 'manual',
        paidAt: now,
        notes: 'Saldo a favor (devolución anterior)',
      },
    });
    const fully = toCents(use) === pendingCents;
    return (await tx.invoice.update({
      where: { id: row.id },
      data: {
        amountPaid: { increment: use },
        ...(fully ? { status: 'paid', paidAt: now } : {}),
      },
      include: this.includeRelations(),
    })) as unknown as T;
  }

  /**
   * Retención de IRPF al emitir: si la factura es de un contrato con retención,
   * se calcula sobre la base de las líneas sujetas o exentas (no sobre la fianza
   * ni el recargo, que no son renta) y se registra como un «pago» no monetario
   * (`withholding`). El total no cambia (es lo que se declara en Veri*Factu);
   * lo pendiente pasa a ser total − retención. Solo facturas completas o
   * simplificadas de contrato; nunca rectificativas ni justificantes de fianza.
   */
  private async applyWithholding<
    T extends {
      id: string;
      contractId: string | null;
      customerId: string | null;
      invoiceType: string;
      kind: string;
      correctionMethod?: string | null;
    },
  >(tx: Prisma.TransactionClient, tenantId: string, row: T): Promise<T> {
    if (!row.contractId || row.kind !== 'invoice') return row;
    // La sustitutiva es la factura que se cobra: lleva su retención como la original.
    const substitute = row.correctionMethod === 'by_substitution';
    if (row.invoiceType !== 'F1' && row.invoiceType !== 'F2' && !substitute) return row;
    const contract = await tx.contract.findUnique({
      where: { id: row.contractId },
      select: { irpfRetentionPct: true },
    });
    const pct = Number(contract?.irpfRetentionPct ?? 0);
    if (pct <= 0) return row;
    const items = await tx.invoiceItem.findMany({
      where: { invoiceId: row.id },
      select: { total: true, taxAmount: true, taxCategory: true },
    });
    const baseCents = items
      .filter((it) => it.taxCategory === 'S1' || it.taxCategory.startsWith('E'))
      .reduce((sum, it) => sum + toCents(it.total) - toCents(it.taxAmount), 0);
    const withholdingCents = Math.round((baseCents * pct) / 100);
    if (withholdingCents <= 0) return row;
    const amount = withholdingCents / 100;
    await tx.payment.create({
      data: {
        tenantId,
        invoiceId: row.id,
        customerId: row.customerId,
        amount,
        status: 'succeeded',
        methodType: 'withholding',
        gateway: 'manual',
        paidAt: new Date(),
        notes: `Retención de IRPF (${pct} %)`,
      },
    });
    return (await tx.invoice.update({
      where: { id: row.id },
      data: {
        withholdingPct: pct,
        withholdingAmount: amount,
        amountPaid: { increment: amount },
      },
      include: this.includeRelations(),
    })) as unknown as T;
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
      kind: row.kind === 'deposit_receipt' ? 'deposit_receipt' : 'invoice',
      bundledWithInvoiceId: row.bundledWithInvoiceId,
      unitId: row.contract?.unit?.id ?? null,
      unitCode: row.contract?.unit?.code ?? null,
      facilityId: row.contract?.unit?.facility?.id ?? null,
      facilityName: row.contract?.unit?.facility?.name ?? null,
      offlinePaymentMethod:
        (row.contract?.offlinePaymentMethod as InvoiceDto['offlinePaymentMethod']) ?? null,
      status: row.status as InvoiceStatusValue,
      invoiceType: row.invoiceType as InvoiceTypeValue,
      rectifiesInvoiceId: row.rectifiesInvoiceId,
      rectifiesInvoiceNumber: row.rectifiesInvoice?.invoiceNumber ?? null,
      rectifiesInvoiceDate: row.rectifiesInvoice?.issueDate
        ? ymd(row.rectifiesInvoice.issueDate)
        : null,
      rectifiedBy: row.rectifiedBy.map((r) => ({
        id: r.id,
        invoiceNumber: r.status === 'draft' ? null : r.invoiceNumber,
        status: r.status as InvoiceStatusValue,
        total: Number(r.total),
      })),
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
      // Solo se debe lo que se está cobrando: un borrador, una anulada o una
      // cancelada no tienen nada pendiente.
      amountPending:
        row.status === 'issued' || row.status === 'overdue'
          ? Math.max(0, Math.round((total - amountPaid) * 100) / 100)
          : 0,
      amountCompensated: row.payments.reduce((sum, p) => sum + toCents(p.amount), 0) / 100,
      withholdingPct: Number(row.withholdingPct),
      ownerId: row.ownerId,
      ownerName: row.owner?.legalName ?? null,
      withholdingAmount: Number(row.withholdingAmount),
      amountDue: Math.round((total - Number(row.withholdingAmount)) * 100) / 100,
      currency: row.currency,
      hasPdf: !!row.pdfUrl,
      notes: row.notes,
      hash: row.hash,
      previousHash: row.previousHash,
      qrCodeUrl: row.qrCodeUrl,
      verifactuMode: row.verifactuMode,
      aeatSentAt: row.aeatSentAt ? row.aeatSentAt.toISOString() : null,
      aeatStatus: row.aeatStatus,
      aeatCsv: row.aeatCsv,
      aeatMessage: aeatResponseMessage(row.aeatResponse),
      holdedDocumentId: row.holdedDocumentId,
      issuedBy: row.issuedBy === 'holded' ? 'holded' : 'app',
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
      voidReason: row.voidReason,
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
      taxCategory: item.taxCategory as InvoiceTaxCategory,
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

/**
 * Número provisional de un borrador (el definitivo se asigna al emitir). Tiene
 * que ser ÚNICO: `invoices` tiene `@@unique([tenantId, invoiceNumber])`. Antes
 * era `DRAFT-${Date.now()}` → dos borradores del mismo tenant creados en el
 * mismo milisegundo chocaban: 409 engañoso `duplicate_period_invoice` al
 * usuario y, en la facturación recurrente (que trata el P2002 como "periodo ya
 * facturado"), una factura SALTADA en silencio.
 */
export function draftPlaceholderNumber(): string {
  return `DRAFT-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Bloquea la fila de la factura hasta el fin de la transacción: serializa las
 * operaciones que leen y reescriben importes o el estado. `FOR NO KEY UPDATE`
 * (no `FOR UPDATE`): no choca con el bloqueo que toma Postgres al apuntar a
 * esta factura desde otra (`previous_invoice_id` de la cadena Veri*Factu). Con
 * `FOR UPDATE`, emitir una rectificativa mientras se emitía otra factura acababa
 * en interbloqueo.
 */
export async function lockInvoiceRow(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid FOR NO KEY UPDATE`;
}

/** `YYYY-MM-DD` de una fecha guardada como día (columnas DATE). */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Un total fuera de rango no cabe en la base de datos (y es un error de tecleo). */
function assertTotalInRange(totalCents: number): void {
  if (Math.abs(totalCents) > MAX_INVOICE_TOTAL_CENTS) {
    throw new BadRequestException({
      code: 'amount_too_large',
      message: 'El importe de la factura es demasiado alto: revisa los precios y las cantidades',
    });
  }
}
