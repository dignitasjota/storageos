import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  addMonthsYmd,
  CLOSED_CASE_STATUSES,
  earliestMoveOutDate,
  effectiveMoveOutDate,
  rentTax,
  resolvePlanFeatures,
} from '@storageos/shared';

import { assertCashDayOpen } from '../../common/cash-day';
import { depositWasCollected } from '../../common/deposit-collected';
import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { addAmounts, isAtLeast, isGreaterThan, subtractAmounts, toCents } from '../../common/money';
import { endDateAfterCancellingMoveOut } from '../../common/move-out';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { isPendingPreOpening, preOpeningDto } from '../../common/pre-opening';
import { releaseReservedUnit, unitHeldByOther } from '../../common/unit-holds';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { FirstInvoiceService } from '../billing/first-invoice.service';
import { InvoicesService } from '../billing/invoices.service';
import { CouponsService, type RedeemedCoupon } from '../coupons/coupons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { PromotionsService } from '../promotions/promotions.service';

import { composeContractTerms, termsHash } from './contract-terms';
import {
  creditForLine,
  prepaidPeriodMonths,
  rentCreditWithoutDiscount,
  unusedPrepaidMonths,
} from './prepay-credit';
import { PricingService } from './pricing.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractDepositSettledPayload,
  ContractPriceNoticePayload,
  ContractRenewedPayload,
  DomainEventPayload,
  MoveOutCancelledPayload,
  ContractUnitChangedPayload,
  UnitAvailablePayload,
  UnitRequestResolvedPayload,
} from '../automations/domain-events';
import type { Contract, ContractStatus, Prisma, UnitStatus } from '@storageos/database';
import type {
  ActivateImportedContractsInput,
  ActivateImportedContractsResultDto,
  AddContractNoteInput,
  CancelContractInput,
  ChangeContractPriceInput,
  ContractAccountDto,
  ContractDto,
  ContractMoveOutDto,
  ContractChecklistDto,
  ContractChecklistStepDto,
  ContractEventDto,
  ContractStatusValue,
  CreateContractInput,
  InvoiceTaxCategory,
  PortalContractDto,
  SettleDepositInput,
  SignedDownloadDto,
  UpdateContractInput,
} from '@storageos/shared';

/** Un contrato cerrado deja sin efecto lo que tuviera programado. */
const NO_SCHEDULED_CHANGES = {
  scheduledPrice: null,
  scheduledPriceDate: null,
  scheduledPriceReason: null,
  scheduledUnitId: null,
  scheduledUnitDate: null,
  scheduledUnitPrice: null,
  scheduledUnitProrate: false,
} as const;

/**
 * Plazo para desistir que se enseña en el área de clientes: solo mientras se
 * pueda (contrato vivo, sin desistir, ya empezado si era una reserva antes de
 * la apertura, y sin pasar el último día en la hora de España).
 */
function portalWithdrawalDeadline(row: {
  status: string;
  withdrawalDeadline: Date | null;
  withdrawnAt: Date | null;
  preOpening: boolean;
  preOpeningStartedAt: Date | null;
}): string | null {
  if (!row.withdrawalDeadline || row.withdrawnAt) return null;
  if (row.status !== 'active' && row.status !== 'ending') return null;
  if (isPendingPreOpening(row)) return null;
  const deadline = row.withdrawalDeadline.toISOString().slice(0, 10);
  return deadline >= todayInTimezone().toISOString().slice(0, 10) ? deadline : null;
}

/** Meses del plazo de un contrato (mínimo 1), para prorrogarlo por lo mismo. */
export function termMonths(start: Date, end: Date): number {
  // El día siguiente al fin cierra el plazo (1 ene → 31 dic = 12 meses).
  const e = new Date(end.getTime() + 86_400_000);
  const months =
    (e.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (e.getUTCMonth() - start.getUTCMonth()) -
    (e.getUTCDate() < start.getUTCDate() ? 1 : 0);
  return Math.min(120, Math.max(1, months));
}

const ALLOWED_TRANSITIONS: Record<ContractStatusValue, ContractStatusValue[]> = {
  draft: ['active', 'cancelled'],
  active: ['ending', 'ended', 'cancelled'],
  ending: ['ended', 'cancelled'],
  ended: [],
  cancelled: [],
};

type ContractWithRelations = Contract & {
  customer: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: 'individual' | 'business';
  };
  unit: {
    code: string;
    facilityId: string;
    facility: { name: string };
    unitType?: { propertyKind: string };
  };
  insurancePlan: { name: string } | null;
  owner?: { legalName: string } | null;
  invoices?: { id: string; invoiceNumber: string; status: string }[];
  couponRedemptions?: {
    months: number;
    discountAmount: Prisma.Decimal;
    freeMonths: number;
    coupon: { code: string };
  }[];
};

/** El justificante de fianza vigente del contrato (para la ficha). */
const DEPOSIT_RECEIPT_SELECT = {
  where: { kind: 'deposit_receipt', deletedAt: null, status: { not: 'cancelled' } },
  select: { id: true, invoiceNumber: true, status: true },
  orderBy: { createdAt: 'desc' },
  take: 1,
} satisfies Prisma.Contract$invoicesArgs;

/** El cupón usado en el primer pago (uno por contrato). */
const COUPON_SELECT = {
  select: {
    months: true,
    discountAmount: true,
    freeMonths: true,
    coupon: { select: { code: true } },
  },
  take: 1,
} satisfies Prisma.Contract$couponRedemptionsArgs;

interface ListFilters {
  /** Atajos de la lista de contratos. */
  view?: 'unsigned' | 'first_payment' | 'ending' | 'expiring' | undefined;
  status?: ContractStatusValue;
  customerId?: string;
  facilityId?: string;
  unitId?: string;
  includeDeleted?: boolean;
  /** Permisos por local: si está, solo contratos de unidades de esos locales. */
  facilityScope?: string[] | null;
  /** Nº de contrato, inquilino o trastero. */
  search?: string;
  page?: PageRequest;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly eventBus: EventEmitter2,
    private readonly promotions: PromotionsService,
    private readonly coupons: CouponsService,
    private readonly firstInvoice: FirstInvoiceService,
    private readonly invoices: InvoicesService,
    private readonly files: FilesService,
    private readonly admin: PrismaAdminService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<ContractDto[]> {
    const where: Prisma.ContractWhereInput = {};
    if (!filters.includeDeleted) where.deletedAt = null;
    if (filters.status) where.status = filters.status as ContractStatus;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.unitId) where.unitId = filters.unitId;
    if (filters.view === 'unsigned') {
      where.status = 'draft';
    } else if (filters.view === 'first_payment') {
      where.status = { in: ['draft', 'active'] };
      where.firstPaymentDeadline = { not: null };
    } else if (filters.view === 'ending') {
      where.status = 'ending';
    } else if (filters.view === 'expiring') {
      const today = todayInTimezone();
      where.status = 'active';
      where.endDate = { gte: today, lte: new Date(today.getTime() + 30 * 86_400_000) };
    }
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return []; // local pedido fuera del scope del usuario
    if (facFilter) where.unit = { facilityId: { in: facFilter } };
    if (filters.search) {
      // Por palabras: «Juan García» encuentra nombre y apellido por separado.
      const words = filters.search.trim().split(/\s+/).filter(Boolean).slice(0, 5);
      where.AND = words.map((word) => {
        const q = { contains: word, mode: 'insensitive' as const };
        return {
          OR: [
            { contractNumber: q },
            { customer: { firstName: q } },
            { customer: { lastName: q } },
            { customer: { companyName: q } },
            { unit: { code: q } },
          ],
        };
      });
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          ...pageArgs(filters.page),
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
                unitType: { select: { propertyKind: true } },
              },
            },
            insurancePlan: { select: { name: true } },
            owner: { select: { legalName: true } },
            invoices: DEPOSIT_RECEIPT_SELECT,
            couponRedemptions: COUPON_SELECT,
          },
        }),
      tenantId,
    );
    const dtos = rows.map((r) => this.toDto(r));
    if (!filters.page || dtos.length === 0) return dtos;
    // La lista enseña la deuda de cada contrato.
    const debts = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.groupBy({
          by: ['contractId'],
          where: {
            contractId: { in: dtos.map((d) => d.id) },
            status: { in: ['issued', 'overdue'] },
            deletedAt: null,
          },
          _sum: { total: true, amountPaid: true },
        }),
      tenantId,
    );
    const pending = new Map(
      debts.map((d) => [
        d.contractId,
        subtractAmounts(Number(d._sum.total ?? 0), Number(d._sum.amountPaid ?? 0)),
      ]),
    );
    for (const d of dtos) d.pendingAmount = pending.get(d.id) ?? 0;
    return dtos;
  }

  /** Contratos activos/en baja que vencen en los próximos `days` (renovación). */
  async listRenewals(
    tenantId: string,
    filters: { facilityId?: string; facilityScope?: string[] | null } = {},
    days = 60,
  ): Promise<ContractDto[]> {
    const ids = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (ids === null) return [];
    // `end_date` es un día: con la hora actual se quedaban fuera los que vencen hoy.
    const today = todayInTimezone();
    const limit = new Date(today.getTime() + days * 86_400_000);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            ...(ids ? { unit: { facilityId: { in: ids } } } : {}),
            deletedAt: null,
            status: { in: ['active', 'ending'] as ContractStatus[] },
            endDate: { not: null, gte: today, lte: limit },
          },
          orderBy: [{ endDate: 'asc' }],
          include: {
            customer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            unit: {
              select: { code: true, facilityId: true, facility: { select: { name: true } } },
            },
            insurancePlan: { select: { name: true } },
            owner: { select: { legalName: true } },
            invoices: DEPOSIT_RECEIPT_SELECT,
            couponRedemptions: COUPON_SELECT,
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<ContractDto> {
    const dto = this.toDto(await this.findOrThrow(tenantId, id, facilityScope));
    if (dto.depositAmount > 0 && !dto.depositCollected) {
      dto.depositCollected = await this.prisma.withTenant(
        (tx) => depositWasCollected(tx, id),
        tenantId,
      );
    }
    if (dto.scheduledMove) {
      const target = await this.prisma.withTenant(
        (tx) =>
          tx.unit.findUnique({
            where: { id: dto.scheduledMove!.unitId },
            select: { code: true },
          }),
        tenantId,
      );
      dto.scheduledMove.unitCode = target?.code ?? null;
    }
    return dto;
  }

  /** Cobros del contrato para su ficha: deuda y próxima factura. */
  async account(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<ContractAccountDto> {
    const c = await this.findOrThrow(tenantId, id, facilityScope);
    const [open, paid, last] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.invoice.findMany({
            where: { contractId: id, status: { in: ['issued', 'overdue'] }, deletedAt: null },
            select: { status: true, total: true, amountPaid: true },
          }),
          tx.payment.aggregate({
            where: {
              invoice: { contractId: id },
              status: { in: ['succeeded', 'partially_refunded'] },
              methodType: { notIn: ['credit_note', 'withholding'] },
            },
            _sum: { amount: true, refundedAmount: true },
          }),
          tx.invoice.findFirst({
            where: {
              contractId: id,
              kind: 'invoice',
              deletedAt: null,
              periodEnd: { not: null },
              status: { notIn: ['draft', 'cancelled'] },
            },
            orderBy: { periodEnd: 'desc' },
            select: { periodEnd: true },
          }),
        ]),
      tenantId,
    );
    const pendingOf = (i: { total: unknown; amountPaid: unknown }) =>
      subtractAmounts(Number(i.total), Number(i.amountPaid));
    const sum = (rows: typeof open) => rows.reduce((acc, i) => addAmounts(acc, pendingOf(i)), 0);
    // La siguiente factura empieza donde acaba lo facturado, salvo que el contrato acabe antes.
    let nextInvoice: ContractAccountDto['nextInvoice'] = null;
    if ((c.status === 'active' || c.status === 'ending') && !isPendingPreOpening(c)) {
      const today = await this.todayAtUnit(tenantId, c.unitId);
      const after = last?.periodEnd ? new Date(last.periodEnd.getTime() + 86_400_000) : null;
      const firstOfNext = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
      const date =
        c.billingIntervalMonths > 1
          ? (after ?? c.billingStartsOn ?? c.startDate)
          : after && after > firstOfNext
            ? after
            : firstOfNext;
      if (!c.endDate || date <= c.endDate) {
        const monthly = subtractAmounts(Number(c.priceMonthly), Number(c.discountAmount));
        const rent = monthly * c.billingIntervalMonths * (1 - Number(c.prepayDiscountPct) / 100);
        const insurance = Number(c.insurancePrice ?? 0) * c.billingIntervalMonths;
        nextInvoice = {
          date: date.toISOString().slice(0, 10),
          amount: Math.round((rent + insurance) * 100) / 100,
        };
      }
    }
    return {
      pendingAmount: sum(open),
      overdueAmount: sum(open.filter((i) => i.status === 'overdue')),
      paidAmount: subtractAmounts(
        Number(paid._sum.amount ?? 0),
        Number(paid._sum.refundedAmount ?? 0),
      ),
      nextInvoice,
    };
  }

  /** Todo lo que hay que resolver para que el inquilino se vaya. */
  async moveOutSummary(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<ContractMoveOutDto> {
    const c = await this.findOrThrow(tenantId, id, facilityScope);
    const [photos, invoices, credentials, others] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.contractInspectionPhoto.count({ where: { contractId: id, kind: 'checkout' } }),
          tx.invoice.findMany({
            where: { contractId: id, status: { in: ['issued', 'overdue'] }, deletedAt: null },
            orderBy: { issueDate: 'asc' },
            select: {
              id: true,
              invoiceNumber: true,
              dueDate: true,
              total: true,
              amountPaid: true,
            },
          }),
          tx.accessCredential.count({
            where: { customerId: c.customerId, status: { in: ['active', 'suspended'] } },
          }),
          tx.contract.count({
            where: {
              customerId: c.customerId,
              id: { not: id },
              status: { in: ['active', 'ending'] },
              deletedAt: null,
            },
          }),
        ]),
      tenantId,
    );
    const pendingInvoices = invoices.map((i) => ({
      id: i.id,
      number: i.invoiceNumber,
      pending: subtractAmounts(Number(i.total), Number(i.amountPaid)),
      dueDate: i.dueDate?.toISOString().slice(0, 10) ?? null,
    }));
    const today = await this.todayAtUnit(tenantId, c.unitId);
    return {
      checkoutPhotos: photos,
      pendingInvoices,
      pendingTotal: pendingInvoices.reduce((acc, i) => addAmounts(acc, i.pending), 0),
      prepaidCredit: await this.prepaidCreditPreview(tenantId, id, c.endDate ?? today),
      hasLiveAccess: credentials > 0,
      otherLiveContracts: others,
    };
  }

  /**
   * Abono de la factura prepagada que cubre la fecha de baja (prepago
   * semestral o anual, o el primer pago de varios meses): los meses enteros
   * sin usar, cobrando los usados a la cuota mensual del contrato, sin el
   * descuento ni los meses gratis de ese pago. La protección de contenido no
   * tiene descuento y se abona en proporción. null si no hay nada que abonar.
   */
  private async prepaidCreditFor(
    tenantId: string,
    contractId: string,
    endDate: Date,
  ): Promise<{
    invoiceId: string;
    months: number;
    unused: number;
    lines: { description: string; base: number; taxRate: number; taxCategory: string }[];
  } | null> {
    const [invoice, contract] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.invoice.findFirst({
            where: {
              contractId,
              invoiceType: 'F1',
              status: { in: ['paid', 'partially_refunded'] },
              periodStart: { lte: endDate },
              periodEnd: { gte: endDate },
            },
            include: { items: true },
            orderBy: { periodStart: 'desc' },
          }),
          tx.contract.findUnique({
            where: { id: contractId },
            select: {
              priceMonthly: true,
              discountAmount: true,
              billingIntervalMonths: true,
              prepaidCreditAtListPrice: true,
            },
          }),
        ]),
      tenantId,
    );
    if (!invoice?.periodStart || !invoice.periodEnd || !contract) return null;
    // Contratos firmados antes del contrato v2: lo que ya se hacía. El prepago
    // semestral o anual se abona en proporción (con su descuento) y el primer
    // pago de varios meses no se abona.
    const legacy = !contract.prepaidCreditAtListPrice;
    if (legacy && contract.billingIntervalMonths <= 1) return null;
    const months = prepaidPeriodMonths(invoice.periodStart, invoice.periodEnd);
    if (months < 2) return null;
    const unused = unusedPrepaidMonths(invoice.periodStart, months, endDate);
    if (unused === 0) return null;

    // Solo las líneas del periodo; la fianza no tiene periodo y se liquida aparte.
    const periodItems = invoice.items.filter((i) => i.periodStart && i.periodEnd);
    const lines: { description: string; base: number; taxRate: number; taxCategory: string }[] = [];
    // El alquiler son las líneas del trastero (con los meses gratis del cupón).
    const rent = legacy ? [] : periodItems.filter((i) => i.relatedUnitId);
    const firstRent = rent[0];
    if (firstRent) {
      const base = rentCreditWithoutDiscount({
        paid: rent.reduce((acc, i) => acc + Number(i.unitPrice) * Number(i.quantity), 0),
        months,
        unused,
        monthlyPrice: Number(contract.priceMonthly) - Number(contract.discountAmount),
      });
      if (base > 0) {
        lines.push({
          description: firstRent.description,
          base,
          taxRate: Number(firstRent.taxRate),
          taxCategory: firstRent.taxCategory,
        });
      }
    }
    for (const i of periodItems.filter((item) => legacy || !item.relatedUnitId)) {
      const base = creditForLine(Number(i.unitPrice) * Number(i.quantity), months, unused);
      if (base > 0) {
        lines.push({
          description: i.description,
          base,
          taxRate: Number(i.taxRate),
          taxCategory: i.taxCategory,
        });
      }
    }
    if (lines.length === 0) return null;
    return { invoiceId: invoice.id, months, unused, lines };
  }

  /** Lo que se abonaría al dar de baja el contrato en `endDate` (con IVA). */
  private async prepaidCreditPreview(
    tenantId: string,
    contractId: string,
    endDate: Date,
  ): Promise<ContractMoveOutDto['prepaidCredit']> {
    const credit = await this.prepaidCreditFor(tenantId, contractId, endDate);
    if (!credit) return null;
    const amount = credit.lines.reduce((acc, l) => acc + l.base * (1 + l.taxRate / 100), 0);
    return { months: credit.unused, amount: Math.round(amount * 100) / 100 };
  }

  /** Hoy en la zona del local del trastero. */
  private async todayAtUnit(tenantId: string, unitId: string): Promise<Date> {
    const unit = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findUnique({
          where: { id: unitId },
          select: { facility: { select: { timezone: true } } },
        }),
      tenantId,
    );
    return todayInTimezone(unit?.facility.timezone ?? 'Europe/Madrid');
  }

  /**
   * URL firmada de corta duración para descargar el PDF firmado (staff). El
   * `signed_pdf_url` guardado es una URL PERMANENTE sin firmar sobre un
   * bucket privado (`uploads`) — nunca se expone tal cual; se firma bajo
   * demanda, mismo patrón que `PortalService.getMyContractPdf`.
   */
  async getSignedPdfUrl(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<SignedDownloadDto> {
    const row = await this.findOrThrow(tenantId, id, facilityScope);
    const url = row.signedPdfUrl
      ? await this.files.presignFromPublicUrl('uploads', row.signedPdfUrl, 300)
      : null;
    if (!url) {
      throw new NotFoundException({
        code: 'signed_pdf_not_available',
        message: 'Aún no hay un PDF firmado generado',
      });
    }
    return { url };
  }

  /**
   * Pasos de la entrada y la salida del contrato: firmado, fotos, acceso,
   * fianza y primera factura cobrada; y, con la baja pedida o el contrato
   * cerrado, fotos de salida, fianza liquidada, acceso retirado y cierre.
   */
  async checklist(
    tenantId: string,
    contractId: string,
    facilityScope?: string[] | null,
  ): Promise<ContractChecklistDto> {
    const c = await this.findOrThrow(tenantId, contractId, facilityScope);
    const [photos, credentials, firstInvoice, otherLive, depositCollected] =
      await this.prisma.withTenant(
        (tx) =>
          Promise.all([
            tx.contractInspectionPhoto.groupBy({
              by: ['kind'],
              where: { contractId },
              _count: { _all: true },
            }),
            tx.accessCredential.count({
              where: { customerId: c.customerId, status: { in: ['active', 'suspended'] } },
            }),
            tx.invoice.findFirst({
              where: {
                contractId,
                kind: 'invoice',
                // También la de una reserva online, que se emite al cobrarse.
                OR: [
                  { status: { notIn: ['draft', 'cancelled'] } },
                  { status: 'draft', issueOnPayment: true },
                ],
              },
              orderBy: { createdAt: 'asc' },
              select: { status: true, invoiceNumber: true, issueOnPayment: true },
            }),
            tx.contract.count({
              where: {
                customerId: c.customerId,
                id: { not: contractId },
                status: { in: ['active', 'ending'] },
                deletedAt: null,
              },
            }),
            depositWasCollected(tx, contractId),
          ]),
        tenantId,
      );
    const photoCount = (kind: string) => photos.find((p) => p.kind === kind)?._count._all ?? 0;
    const deposit = Number(c.depositAmount);
    const moveIn: ContractChecklistStepDto[] = [
      {
        key: 'signed',
        label: 'Contrato firmado',
        done: !!c.signedAt,
        hint: c.signedAt ? null : 'Pide la firma desde la pestaña «Firma».',
      },
      {
        key: 'checkin_photos',
        label: 'Fotos de entrada del trastero',
        done: photoCount('checkin') > 0,
        hint: photoCount('checkin') > 0 ? null : 'Sube las fotos del estado a la entrada.',
      },
      {
        key: 'first_invoice',
        label: 'Primera factura cobrada',
        done: firstInvoice?.status === 'paid',
        hint: !firstInvoice
          ? 'Aún no hay factura emitida.'
          : firstInvoice.status === 'paid'
            ? null
            : firstInvoice.status === 'draft'
              ? 'Primer pago pendiente: la factura se emite al cobrarse.'
              : `Factura ${firstInvoice.invoiceNumber} pendiente de cobro.`,
      },
      {
        key: 'deposit',
        label: 'Fianza recibida',
        done: deposit <= 0 || depositCollected,
        hint:
          deposit <= 0 || depositCollected
            ? null
            : 'Sin cobrar: registra el cobro desde la tarjeta de la fianza.',
      },
      {
        key: 'access',
        label: 'Acceso entregado',
        done: credentials > 0,
        hint: credentials > 0 ? null : 'El inquilino aún no tiene PIN ni tarjeta.',
      },
    ];
    let moveOut: ContractChecklistStepDto[] | null = null;
    if (c.status === 'ending' || c.status === 'ended') {
      const depositSettled = deposit <= 0 || !!c.depositSettledAt;
      moveOut = [
        {
          key: 'checkout_photos',
          label: 'Fotos de salida del trastero',
          done: photoCount('checkout') > 0,
          hint: photoCount('checkout') > 0 ? null : 'Sube las fotos del estado a la salida.',
        },
        {
          key: 'deposit_settled',
          label: 'Fianza liquidada',
          done: depositSettled,
          hint: depositSettled ? null : 'Devuelve o retén la fianza desde su tarjeta.',
        },
        {
          key: 'access_removed',
          label: 'Acceso retirado',
          done: otherLive > 0 || credentials === 0,
          hint:
            otherLive > 0
              ? 'Conserva el acceso: tiene otro contrato en vigor.'
              : credentials === 0
                ? null
                : 'Se retira solo al cerrar el contrato.',
        },
        {
          key: 'closed',
          label: 'Contrato cerrado',
          done: c.status === 'ended',
          hint:
            c.status === 'ended'
              ? null
              : c.endDate
                ? `Se cierra el ${c.endDate.toISOString().slice(0, 10)}.`
                : 'Pendiente de cerrar.',
        },
      ];
    }
    return { moveIn, moveOut };
  }

  async events(
    tenantId: string,
    contractId: string,
    facilityScope?: string[] | null,
  ): Promise<ContractEventDto[]> {
    await this.findOrThrow(tenantId, contractId, facilityScope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.contractEvent.findMany({
          where: { contractId },
          orderBy: { occurredAt: 'desc' },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      payload: (r.payload as Record<string, unknown>) ?? {},
      createdByUserId: r.createdByUserId,
      createdByName: r.createdBy?.fullName ?? null,
      occurredAt: r.occurredAt.toISOString(),
    }));
  }

  async create(args: {
    tenantId: string;
    userId: string | null;
    input: CreateContractInput;
    meta: RequestMeta;
    /** Permisos por local: la unidad debe estar en el scope del usuario. */
    facilityScope?: string[] | null;
  }): Promise<ContractDto> {
    const { tenantId, input } = args;
    // Gating por plan: el seguro requiere la feature `insurance`.
    if (input.insurancePlanId) await this.assertInsuranceFeature(tenantId);
    if (input.couponCode?.trim() && input.promotionCode?.trim()) {
      throw new BadRequestException({
        code: 'coupon_with_promotion',
        message: 'Un cupón no se puede combinar con un código promocional',
      });
    }
    if (input.couponCode?.trim() && Number(input.discountAmount ?? 0) > 0) {
      throw new BadRequestException({
        code: 'coupon_with_discount',
        message: 'Un cupón no se puede combinar con un descuento manual',
      });
    }
    if (input.endDate && input.endDate < input.startDate) {
      throw new BadRequestException({
        code: 'invalid_end_date',
        message: 'La fecha de fin no puede ser anterior a la de inicio',
      });
    }
    if (isGreaterThan(Number(input.discountAmount ?? 0), Number(input.priceMonthly))) {
      throw new BadRequestException({
        code: 'discount_too_high',
        message: 'El descuento no puede ser mayor que la cuota',
      });
    }
    const result = await this.prisma.withTenant(async (tx) => {
      let freedUnitId: string | null = null;
      let requestClosed = false;
      // Validar customer y unit pertenecientes a este tenant.
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, deletedAt: null },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      const unit = await tx.unit.findUnique({
        where: { id: input.unitId },
        include: { facility: { select: { deletedAt: true } } },
      });
      if (!unit || unit.facility.deletedAt) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
      assertFacilityAllowed(args.facilityScope, unit.facilityId);
      // Reserva que se convierte: el contrato sale de su trastero y su inquilino.
      const reservation = input.reservationId
        ? await tx.reservation.findFirst({
            where: { id: input.reservationId, status: { in: ['pending', 'confirmed'] } },
            select: { id: true, unitId: true, customerId: true, depositInvoiceId: true },
          })
        : null;
      if (input.reservationId) {
        if (!reservation) {
          throw new BadRequestException({
            code: 'reservation_not_convertible',
            message: 'Solo se pueden convertir reservas pendientes o confirmadas',
          });
        }
        if (
          reservation.unitId !== input.unitId ||
          (reservation.customerId && reservation.customerId !== input.customerId)
        ) {
          throw new BadRequestException({
            code: 'reservation_mismatch',
            message: 'La reserva es de otro trastero o de otro inquilino',
          });
        }
      }
      // El contrato guarda el propietario del local al crearse (plan
      // Administrador): reasignar luego el local no cambia sus facturas.
      const facilityOwner = await tx.facility.findUnique({
        where: { id: unit.facilityId },
        select: {
          ownerId: true,
          preOpening: true,
          openingDate: true,
          preOpeningMaxMonths: true,
          timezone: true,
        },
      });
      // Local por abrir: reserva anticipada. Primer pago = una mensualidad
      // completa (sin prepago; el cupón descuenta esa mensualidad) y el alquiler empieza el día de
      // apertura; sin fecha fijada, la de inicio es la fecha límite
      // (provisional) y nada se factura ni da acceso hasta que abra.
      let preOpening: {
        startDate: Date;
        dateConfirmed: boolean;
        deadline: Date;
      } | null = null;
      if (facilityOwner?.preOpening) {
        const today = todayInTimezone(facilityOwner.timezone).toISOString().slice(0, 10);
        const deadline = addMonthsYmd(today, facilityOwner.preOpeningMaxMonths);
        const opening = facilityOwner.openingDate?.toISOString().slice(0, 10) ?? null;
        preOpening = {
          startDate: new Date(`${opening ?? deadline}T00:00:00Z`),
          dateConfirmed: !!opening,
          deadline: new Date(`${deadline}T00:00:00Z`),
        };
      }
      // En draft permitimos crear el contrato aunque el unit no este available
      // (p.ej. esta reserved para este mismo customer). Sera al firmar
      // cuando bloqueemos si esta occupied/maintenance/blocked.

      // Código promocional: si es válido (percentage/fixed), calcula el
      // descuento recurrente y registra el uso. Tiene prioridad sobre un
      // `discountAmount` manual.
      let discountAmount = input.discountAmount;
      let discountReason = input.discountReason?.trim() || null;
      let promotionId: string | null = null;
      let freeMonthsRemaining = 0;
      if (input.promotionCode?.trim()) {
        const applied = await this.promotions.applyToContractTx(
          tx,
          tenantId,
          input.promotionCode,
          Number(input.priceMonthly),
          input.unitId,
        );
        discountAmount = applied.discountAmount;
        discountReason = applied.discountReason;
        promotionId = applied.promotionId;
        freeMonthsRemaining = applied.freeMonths;
      }

      // Seguro opcional: congela la prima del plan activo en el contrato.
      let insurancePlanId: string | null = null;
      let insurancePrice: number | null = null;
      if (input.insurancePlanId) {
        const plan = await tx.insurancePlan.findFirst({
          where: { id: input.insurancePlanId, tenantId, isActive: true },
          select: { id: true, monthlyPrice: true },
        });
        if (!plan) {
          throw new NotFoundException({
            code: 'insurance_plan_not_found',
            message: 'Plan de seguro no encontrado o inactivo',
          });
        }
        insurancePlanId = plan.id;
        insurancePrice = Number(plan.monthlyPrice);
      }

      // Cupón: descuento solo sobre el primer pago. Se reserva el uso aquí;
      // la 1ª factura lo aplica al firmar.
      const billingIntervalMonths = preOpening ? 1 : input.billingIntervalMonths;
      const firstPaymentMonths =
        preOpening || billingIntervalMonths > 1 ? 1 : input.firstPaymentMonths;
      let redeemed: RedeemedCoupon | null = null;
      if (input.couponCode?.trim()) {
        const months = billingIntervalMonths > 1 ? billingIntervalMonths : firstPaymentMonths;
        const signedBefore = await tx.contract.count({
          where: { tenantId, customerId: input.customerId, signedAt: { not: null } },
        });
        const monthlyPrice = Number(input.priceMonthly) - Number(discountAmount);
        redeemed = await this.coupons.redeemInTx(tx, tenantId, input.couponCode, {
          monthlyPrice,
          months,
          unitTypeId: unit.unitTypeId,
          facilityId: unit.facilityId,
          isNewCustomer: signedBefore === 0,
          customerId: input.customerId,
          preOpening: !!preOpening,
        });
        // Con prepago semestral/anual con descuento se aplica el mejor de los dos.
        const prepayPct = billingIntervalMonths > 1 ? input.prepayDiscountPct : 0;
        if (prepayPct > 0) {
          const prepayCents = Math.round((toCents(monthlyPrice) * months * prepayPct) / 100);
          if (prepayCents >= toCents(redeemed.quote.discountAmount)) {
            throw new BadRequestException({
              code: 'coupon_not_better',
              message: 'El descuento por pagar por adelantado ya es mayor que el de este cupón',
            });
          }
        }
      }

      const contractNumber = await this.nextContractNumber(tx, tenantId);
      const row = await tx.contract.create({
        data: {
          tenantId,
          customerId: input.customerId,
          unitId: input.unitId,
          contractNumber,
          status: 'draft',
          startDate: preOpening?.startDate ?? new Date(input.startDate),
          ...(input.endDate ? { endDate: new Date(input.endDate) } : {}),
          billingCycle: input.billingCycle,
          billingIntervalMonths,
          ...(preOpening
            ? {
                preOpening: true,
                preOpeningDateConfirmed: preOpening.dateConfirmed,
                preOpeningDeadline: preOpening.deadline,
              }
            : {}),
          firstPaymentMonths,
          irpfRetentionPct: input.irpfRetentionPct ?? 0,
          ownerId: facilityOwner?.ownerId ?? null,
          // El descuento por prepago solo aplica con interval>1 (mensual = 0).
          prepayDiscountPct: billingIntervalMonths > 1 ? input.prepayDiscountPct : 0,
          priceMonthly: input.priceMonthly,
          discountAmount,
          discountReason,
          promotionId,
          freeMonthsRemaining,
          // Inquilino «sin fianza»: sus contratos nuevos no llevan fianza.
          depositAmount: customer.depositExempt ? 0 : input.depositAmount,
          depositPaymentMethod: input.depositPaymentMethod ?? 'online',
          insurancePlanId,
          insurancePrice,
          autoRenew: input.autoRenew,
          cancellationNoticeDays: input.cancellationNoticeDays,
          notes: input.notes?.trim() || null,
          events: {
            create: {
              tenantId,
              eventType: 'created',
              payload: {
                contractNumber,
                unitId: input.unitId,
                customerId: input.customerId,
              },
              createdByUserId: args.userId,
            },
          },
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      if (redeemed) {
        await this.coupons.recordRedemptionInTx(tx, tenantId, redeemed, {
          customerId: input.customerId,
          contractId: row.id,
          invoiceId: null,
        });
      }
      if (input.waitlistEntryId) {
        const entry = await tx.waitlistEntry.findFirst({
          where: { id: input.waitlistEntryId, status: { in: ['waiting', 'notified'] } },
          select: { heldUnitId: true },
        });
        const otherUnit =
          entry?.heldUnitId && entry.heldUnitId !== input.unitId ? entry.heldUnitId : null;
        // El trastero guardado sigue reservado hasta firmar: lo retiene este contrato.
        await tx.waitlistEntry.updateMany({
          where: { id: input.waitlistEntryId, status: { in: ['waiting', 'notified'] } },
          data: {
            status: 'converted',
            convertedContractId: row.id,
            holdTokenHash: null,
            ...(otherUnit ? { heldUnitId: null } : {}),
          },
        });
        // Se ha quedado con otro trastero: el guardado vuelve a la venta.
        if (
          otherUnit &&
          (await releaseReservedUnit(tx, {
            tenantId,
            unitId: otherUnit,
            userId: args.userId,
            reason: `Lista de espera: contrato ${row.contractNumber} sobre otro trastero`,
          }))
        ) {
          freedUnitId = otherUnit;
        }
      }
      if (input.unitRequestId) {
        const closed = await tx.unitRequest.updateMany({
          where: { id: input.unitRequestId, customerId: input.customerId, status: 'pending' },
          data: {
            status: 'handled',
            resolutionNote: `Contrato ${row.contractNumber} creado`,
            handledByUserId: args.userId,
            handledAt: new Date(),
          },
        });
        requestClosed = closed.count > 0;
      }
      if (reservation) {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: 'converted', convertedContractId: row.id },
        });
        // La señal ya cobrada se descuenta de la primera factura del contrato.
        const credit = await this.signalCredit(tx, reservation.depositInvoiceId);
        if (credit) {
          await tx.contract.update({
            where: { id: row.id },
            data: { pendingCreditAmount: credit.amount, pendingCreditReason: credit.reason },
          });
        }
      }
      return { row, redeemed, freedUnitId, requestClosed };
    }, tenantId);
    const created = result.row;
    if (result.freedUnitId) {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId,
        unitId: result.freedUnitId,
      } satisfies UnitAvailablePayload);
    }
    if (result.requestClosed) {
      this.eventBus.emit(DOMAIN_EVENTS.unit_request_resolved, {
        tenantId,
        customerId: created.customerId,
        request: 'additional',
        outcome: 'handled',
        note: `Te hemos preparado el contrato ${created.contractNumber}.`,
      } satisfies UnitRequestResolvedPayload);
    }

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'contract.created',
      entityType: 'Contract',
      entityId: created.id,
      changes: {
        contractNumber: created.contractNumber,
        customerId: created.customerId,
        unitId: created.unitId,
        ...(result.redeemed ? { couponCode: result.redeemed.code } : {}),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    const dto = this.toDto(created);
    if (result.redeemed) {
      const q = result.redeemed.quote;
      dto.coupon = {
        code: result.redeemed.code,
        months: q.months,
        discountAmount: q.discountAmount,
        freeMonths: q.freeMonths,
      };
    }
    return dto;
  }

  async update(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    input: UpdateContractInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status === 'ended' || existing.status === 'cancelled') {
      throw new BadRequestException({
        code: 'contract_closed',
        message: 'El contrato ya no está vivo',
      });
    }
    if (existing.status === 'ending' && args.input.endDate === '') {
      throw new BadRequestException({
        code: 'ending_requires_date',
        message: 'Un contrato en baja necesita su fecha de fin: para anularla, usa «Renovar»',
      });
    }
    // En estados activos solo permitimos cambios "meta" (notas, autoRenew,
    // endDate planificada, dias preaviso). El precio cambia via endpoint
    // dedicado para que sea auditeable.
    const data: Prisma.ContractUpdateInput = {};
    const changes: Record<string, unknown> = {};
    // Precio, inicio y fianza solo se tocan antes de la firma: después el
    // precio cambia con «Cambiar precio» (auditado) y lo firmado no se altera.
    const draftOnly = (['priceMonthly', 'startDate', 'depositAmount'] as const).filter(
      (k) => args.input[k] !== undefined,
    );
    if (draftOnly.length > 0 && existing.status !== 'draft') {
      throw new BadRequestException({
        code: 'contract_not_draft',
        message: 'El precio, la fecha de inicio y la fianza solo se cambian antes de la firma',
      });
    }
    if (
      args.input.priceMonthly !== undefined &&
      Number(existing.priceMonthly) !== args.input.priceMonthly
    ) {
      // El cupón se calculó con la cuota de entonces.
      const withCoupon = await this.prisma.withTenant(
        (tx) => tx.couponRedemption.count({ where: { contractId: existing.id } }),
        args.tenantId,
      );
      if (withCoupon > 0) {
        throw new BadRequestException({
          code: 'coupon_price_locked',
          message:
            'Este contrato lleva un cupón calculado con su cuota: para cambiarla, cancélalo y crea otro',
        });
      }
      // El descuento de una promoción se calculó con la cuota de entonces.
      if (existing.promotionId) {
        throw new BadRequestException({
          code: 'promotion_price_locked',
          message:
            'Este contrato lleva una promoción calculada con su cuota: para cambiarla, cancélalo y crea otro',
        });
      }
      data.priceMonthly = args.input.priceMonthly;
      changes.priceMonthly = { from: Number(existing.priceMonthly), to: args.input.priceMonthly };
    }
    if (args.input.startDate !== undefined) {
      data.startDate = new Date(`${args.input.startDate}T00:00:00.000Z`);
      changes.startDate = args.input.startDate;
    }
    if (args.input.depositAmount !== undefined) {
      data.depositAmount = args.input.depositAmount;
      changes.depositAmount = args.input.depositAmount;
    }
    if (args.input.endDate !== undefined) {
      data.endDate = args.input.endDate ? new Date(args.input.endDate) : null;
      data.endingSoonNotifiedAt = null;
      changes.endDate = args.input.endDate;
    }
    const effectiveStart = args.input.startDate ?? existing.startDate.toISOString().slice(0, 10);
    const effectiveEnd =
      args.input.endDate !== undefined
        ? args.input.endDate
        : (existing.endDate?.toISOString().slice(0, 10) ?? null);
    if (effectiveEnd && effectiveEnd < effectiveStart) {
      throw new BadRequestException({
        code: 'invalid_end_date',
        message: 'La fecha de fin no puede ser anterior a la de inicio',
      });
    }
    if (
      args.input.discountAmount !== undefined &&
      args.input.discountAmount > 0 &&
      existing.status === 'draft'
    ) {
      // El cupón ya está calculado sobre la cuota: no se le suma un descuento manual.
      const withCoupon = await this.prisma.withTenant(
        (tx) => tx.couponRedemption.count({ where: { contractId: existing.id } }),
        args.tenantId,
      );
      if (withCoupon > 0) {
        throw new BadRequestException({
          code: 'coupon_with_discount',
          message: 'Un cupón no se puede combinar con un descuento manual',
        });
      }
    }
    const effectivePrice = args.input.priceMonthly ?? Number(existing.priceMonthly);
    const effectiveDiscount =
      existing.status === 'draft'
        ? (args.input.discountAmount ?? Number(existing.discountAmount))
        : Number(existing.discountAmount);
    if (isGreaterThan(effectiveDiscount, effectivePrice)) {
      throw new BadRequestException({
        code: 'discount_too_high',
        message: 'El descuento no puede ser mayor que la cuota',
      });
    }
    if (args.input.discountAmount !== undefined && existing.status === 'draft') {
      data.discountAmount = args.input.discountAmount;
      changes.discountAmount = args.input.discountAmount;
    }
    if (args.input.discountReason !== undefined && existing.status === 'draft') {
      data.discountReason = args.input.discountReason?.trim() || null;
      changes.discountReason = data.discountReason;
    }
    if (args.input.autoRenew !== undefined) {
      data.autoRenew = args.input.autoRenew;
      changes.autoRenew = args.input.autoRenew;
    }
    if (args.input.cancellationNoticeDays !== undefined) {
      data.cancellationNoticeDays = args.input.cancellationNoticeDays;
      changes.cancellationNoticeDays = args.input.cancellationNoticeDays;
    }
    if (args.input.notes !== undefined) {
      data.notes = args.input.notes?.trim() || null;
      changes.notes = data.notes;
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      // Cambios tras la firma: quedan en el historial del contrato.
      if (existing.status !== 'draft' && Object.keys(changes).length > 0) {
        await tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'note_added',
            payload: { event: 'conditions_updated', changes } as Prisma.InputJsonValue,
            createdByUserId: args.userId,
          },
        });
      }
      return tx.contract.update({
        where: { id: args.contractId },
        data,
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.updated',
      entityType: 'Contract',
      entityId: updated.id,
      changes: changes as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  async sign(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
    /** Firma electrónica simple (remota, asistida o self-service). */
    signature?: {
      signerName: string;
      signerEmail?: string | null;
      method: 'drawn' | 'typed';
      signatureImage?: string | null;
      typedSignature?: string | null;
      channel?: string;
    };
    /**
     * Si true, NO se emite el acceso al firmar: queda diferido a que se pague la
     * 1ª factura (reserva online con pago obligatorio). Lo marca el booking.
     */
    deferAccessUntilPaid?: boolean;
    /** Huella del texto que vio el firmante (firma por enlace). */
    expectedTermsHash?: string;
    /**
     * Firma a distancia de un particular: último día para desistir y, si lo
     * pidió, cuándo pidió empezar antes de que acabe ese plazo.
     */
    withdrawal?: { deadline: string; immediateStartRequestedAt: Date | null };
    /**
     * La 1ª factura la prepara quien llama (firma por enlace: en una reserva
     * online queda pendiente de pago y se emite al cobrarse).
     */
    deferFirstInvoice?: boolean;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'active');

    const updated = await this.prisma
      .withTenant(async (tx) => {
        // Anti-doble-ocupación: serializa por trastero con un advisory lock (se
        // libera al commit), igual que el booking público. Dos firmas concurrentes
        // sobre la misma unidad se ordenan; la 2ª ve la unidad ya `occupied` → 409.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${existing.unitId}::text))`;
        // Verificar que el unit este disponible. Permitimos reserved si la
        // reserva pertenece al mismo customer (la conversion de reserva
        // pasa por aqui despues de convertirla).
        const unit = await tx.unit.findUnique({
          where: { id: existing.unitId },
          include: { facility: { select: { deletedAt: true } } },
        });
        if (!unit) {
          throw new NotFoundException({ code: 'unit_not_found', message: 'Unit perdida' });
        }
        if (unit.facility.deletedAt) {
          throw new ConflictException({
            code: 'facility_deleted',
            message: 'No se puede firmar: el local de este trastero se ha borrado.',
          });
        }
        if (unit.status !== 'available' && unit.status !== 'reserved') {
          throw new ConflictException({
            code: 'unit_not_available',
            message: `No se puede firmar: el trastero esta en estado ${unit.status}`,
          });
        }
        // Una reserva viva del trastero para OTRO inquilino lo bloquea; la del
        // mismo inquilino queda convertida en este contrato.
        const liveReservations = await tx.reservation.findMany({
          where: { unitId: existing.unitId, status: { in: ['pending', 'confirmed'] } },
          select: { id: true, customerId: true },
        });
        // Una reserva sin inquilino también retiene el trastero.
        const foreign = liveReservations.find((r) => r.customerId !== existing.customerId);
        if (foreign) {
          throw new ConflictException({
            code: 'unit_reserved_for_other',
            message:
              'Este trastero está reservado para otro inquilino. Cancela esa reserva antes de firmar.',
          });
        }
        // Tampoco si lo retiene otro inquilino con una reserva online en plazo.
        if (
          unit.status === 'reserved' &&
          (await unitHeldByOther(tx, {
            unitId: existing.unitId,
            contractId: existing.id,
            customerId: existing.customerId,
          }))
        ) {
          throw new ConflictException({
            code: 'unit_reserved_for_other',
            message:
              'Este trastero está retenido por la reserva de otro inquilino. Elige otro o espera a que caduque.',
          });
        }
        const own = liveReservations.filter((r) => r.customerId === existing.customerId);
        if (own.length > 0) {
          await tx.reservation.updateMany({
            where: { id: { in: own.map((r) => r.id) } },
            data: { status: 'converted', convertedContractId: existing.id },
          });
        }

        const signedAt = new Date();
        // Reserva anticipada: la fecha de inicio es la de apertura, si ya la hay.
        let preOpeningSign: Prisma.ContractUpdateInput = {};
        if (existing.preOpening && !existing.preOpeningStartedAt) {
          // La fecha límite se fijó al crear la reserva (es la que ha leído el
          // cliente); la de inicio sigue la apertura del local.
          const facility = await tx.facility.findUniqueOrThrow({
            where: { id: unit.facilityId },
            select: { openingDate: true },
          });
          preOpeningSign = {
            preOpeningDateConfirmed: !!facility.openingDate,
            startDate: facility.openingDate ?? existing.preOpeningDeadline ?? existing.startDate,
          };
        }
        const row = await tx.contract.update({
          where: { id: args.contractId },
          data: {
            ...preOpeningSign,
            status: 'active',
            signedAt,
            // El enlace de firma sigue valiendo hasta su caducidad: al reabrirlo
            // muestra «ya firmado» y deja pagar la 1ª factura pendiente.
            // Si el contrato lleva fianza, queda RETENIDA al activarse (se liquida
            // al finalizar vía settleDeposit). No pisa un estado ya avanzado.
            ...(Number(existing.depositAmount) > 0 && existing.depositStatus === 'none'
              ? { depositStatus: 'held' as const }
              : {}),
          },
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
                unitType: { select: { propertyKind: true } },
              },
            },
            insurancePlan: { select: { name: true } },
            owner: { select: { legalName: true } },
            invoices: DEPOSIT_RECEIPT_SELECT,
            couponRedemptions: COUPON_SELECT,
          },
        });
        await tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'signed',
            payload: { signedAt: signedAt.toISOString() },
            createdByUserId: args.userId,
          },
        });
        // Una reserva anticipada deja el trastero reservado hasta la apertura.
        const signedUnitStatus: UnitStatus = isPendingPreOpening(existing)
          ? 'reserved'
          : 'occupied';
        if (unit.status !== signedUnitStatus) {
          await this.syncUnitStatus(
            tx,
            args,
            existing.unitId,
            unit.status as UnitStatus,
            signedUnitStatus,
            `Contrato ${row.contractNumber} firmado`,
          );
        }

        // Texto firmado = el mismo que ve el inquilino (arrendador, inquilino,
        // condiciones económicas, cláusulas y consentimiento eIDAS). Se congela
        // en `signedTermsText`: editar la plantilla después no altera este contrato.
        const terms = await composeContractTerms(tx, args.tenantId, args.contractId, {
          withdrawalForm: !!args.withdrawal,
        });
        const documentHash = termsHash(terms.text);
        // Si el contrato cambió desde que el inquilino abrió el enlace, no firma
        // un texto que no ha visto.
        if (args.expectedTermsHash && args.expectedTermsHash !== documentHash) {
          throw new ConflictException({
            code: 'terms_changed',
            message:
              'El contrato ha cambiado mientras lo revisabas. Vuelve a leerlo antes de firmar.',
          });
        }
        await tx.contract.update({
          where: { id: args.contractId },
          data: {
            signedTermsText: terms.text,
            signedClausesText: terms.clauses,
            // Las reglas que dice este texto se quedan con el contrato aunque el
            // negocio cambie después su plantilla.
            moveOutEndOfMonth: terms.moveOutEndOfMonth,
            prepaidCreditAtListPrice: true,
            ...(args.withdrawal
              ? {
                  withdrawalDeadline: new Date(`${args.withdrawal.deadline}T00:00:00Z`),
                  immediateStartRequestedAt: args.withdrawal.immediateStartRequestedAt,
                }
              : {}),
          },
        });

        // Registro probatorio de la firma electrónica simple.
        if (args.signature) {
          await tx.contractSignature.create({
            data: {
              tenantId: args.tenantId,
              contractId: args.contractId,
              signerName: args.signature.signerName,
              signerEmail: args.signature.signerEmail ?? null,
              method: args.signature.method,
              signatureImage: args.signature.signatureImage ?? null,
              typedSignature: args.signature.typedSignature ?? null,
              documentHash,
              ipAddress: args.meta.ipAddress ?? null,
              userAgent: args.meta.userAgent ?? null,
              channel: args.signature.channel ?? 'remote',
            },
          });
        }
        return row;
      }, args.tenantId)
      .catch((err: unknown) => {
        // Índice único parcial `contracts_one_active_per_unit`: si (pese al lock)
        // se intentara activar un 2º contrato en la misma unidad → 409 claro.
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          throw new ConflictException({
            code: 'unit_not_available',
            message: 'El trastero ya tiene un contrato activo',
          });
        }
        throw err;
      });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.signed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { contractNumber: updated.contractNumber },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findFirst({
          where: { id: updated.customerId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
            customerType: true,
          },
        }),
      args.tenantId,
    );
    const recipientName =
      customer?.customerType === 'business'
        ? (customer.companyName ?? 'Empresa')
        : [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || 'Cliente';
    const payload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'contract',
      entityId: updated.id,
      recipientEmail: customer?.email ?? null,
      recipientPhone: customer?.phone ?? null,
      customerId: updated.customerId,
      scope: {
        customer: {
          firstName: customer?.firstName ?? '',
          lastName: customer?.lastName ?? '',
          displayName: recipientName,
          email: customer?.email ?? '',
        },
        contract: {
          number: updated.contractNumber,
          priceMonthly: Number(updated.priceMonthly).toFixed(2),
          startDate: updated.startDate.toISOString().slice(0, 10),
          endDate: updated.endDate?.toISOString().slice(0, 10) ?? '',
        },
        unit: { code: updated.unit.code },
        facility: { name: updated.unit.facility.name },
        // Reserva anticipada: el acceso llega el día de apertura.
        ...(args.deferAccessUntilPaid || isPendingPreOpening(existing)
          ? { deferAccess: true }
          : {}),
      },
    };
    this.eventBus.emit(DOMAIN_EVENTS.contract_signed, payload);
    // Cupón o primer pago de varios meses: la 1ª factura sale al firmar (sin
    // esperar a la recurrente) para aplicar el cupón al pago de ahora.
    if (
      !args.deferFirstInvoice &&
      (await this.firstInvoice.needsOnSign(args.tenantId, updated.id))
    ) {
      // Reserva online firmada en el local: también entra en vigor con el
      // primer pago, así que su factura se emite al cobrarse.
      await this.firstInvoice.issueIfMissing(args.tenantId, updated.id, updated.customerId, {
        issueOnPayment: updated.firstPaymentDeadline !== null,
      });
    }
    return this.toDto(updated);
  }

  /**
   * Activa en bloque contratos migrados de otro sistema (importados como
   * borradores). Quedan activos con su fecha de alta original y el trastero
   * ocupado, sin firma electrónica ni avisos: NO se emite `contract_signed`
   * (evita 200 correos de «contrato firmado», PIN nuevos y automatizaciones al
   * migrar una cartera). La facturación empieza en `billingStartsOn`. Cada
   * contrato va por separado: uno que falla no impide los demás.
   */
  async activateImported(args: {
    tenantId: string;
    userId: string;
    facilityScope?: string[] | null;
    input: ActivateImportedContractsInput;
    meta: RequestMeta;
  }): Promise<ActivateImportedContractsResultDto> {
    const billingStartsOn = new Date(`${args.input.billingStartsOn}T00:00:00.000Z`);
    let activated = 0;
    const failed: ActivateImportedContractsResultDto['failed'] = [];
    for (const contractId of [...new Set(args.input.contractIds)]) {
      let contractNumber: string | null = null;
      try {
        const existing = await this.findOrThrow(args.tenantId, contractId, args.facilityScope);
        contractNumber = existing.contractNumber;
        if (existing.status !== 'draft') {
          throw new BadRequestException({
            code: 'contract_not_draft',
            message: 'Solo se activan contratos en borrador',
          });
        }
        await this.prisma.withTenant(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${existing.unitId}::text))`;
          const unit = await tx.unit.findUnique({ where: { id: existing.unitId } });
          if (!unit || (unit.status !== 'available' && unit.status !== 'reserved')) {
            throw new ConflictException({
              code: 'unit_not_available',
              message: `El trastero está ${unit?.status ?? 'perdido'}`,
            });
          }
          const hasDeposit = Number(existing.depositAmount) > 0;
          await tx.contract.update({
            where: { id: contractId },
            data: {
              status: 'active',
              // Alta original: la del sistema anterior.
              signedAt: existing.startDate,
              billingStartsOn,
              ...(hasDeposit && args.input.depositCollected && existing.depositStatus === 'none'
                ? { depositStatus: 'held' as const }
                : {}),
            },
          });
          await tx.contractEvent.create({
            data: {
              tenantId: args.tenantId,
              contractId,
              eventType: 'signed',
              payload: {
                migrated: true,
                billingStartsOn: args.input.billingStartsOn,
                depositCollected: hasDeposit ? args.input.depositCollected : null,
              },
              createdByUserId: args.userId,
            },
          });
          await this.syncUnitStatus(
            tx,
            args,
            existing.unitId,
            unit.status as UnitStatus,
            'occupied',
            `Contrato ${existing.contractNumber} migrado`,
          );
        }, args.tenantId);
        activated += 1;
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err && err.code === 'P2002'
            ? 'El trastero ya tiene un contrato activo'
            : err instanceof HttpException
              ? ((err.getResponse() as { message?: string }).message ?? err.message)
              : err instanceof Error
                ? err.message
                : String(err);
        failed.push({ contractId, contractNumber, error: code });
      }
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.imported_activated',
      entityType: 'Contract',
      entityId: null,
      changes: {
        activated,
        failed: failed.length,
        billingStartsOn: args.input.billingStartsOn,
        depositCollected: args.input.depositCollected,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return { activated, failed };
  }

  async requestEnd(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    /** Último día del contrato (YYYY-MM-DD). Sin ella: hoy + días de preaviso. */
    endDate?: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'ending');
    if (isPendingPreOpening(existing)) {
      throw new BadRequestException({
        code: 'pre_opening_not_started',
        message: 'La reserva aún no ha empezado: cancélala como reserva antes de la apertura',
      });
    }
    // Sin fecha de fin la recurrente seguía facturando y la baja no salía en «Hoy».
    // Sin fecha, la primera posible (a final de mes si el contrato se firmó así);
    // con fecha, la que ponga el equipo (puede ser una baja pactada).
    const today = await this.todayAtUnit(args.tenantId, existing.unitId);
    const endDate = new Date(
      `${
        args.endDate ??
        earliestMoveOutDate({
          today: today.toISOString().slice(0, 10),
          noticeDays: existing.cancellationNoticeDays,
          endOfMonth: existing.moveOutEndOfMonth === true,
        })
      }T00:00:00Z`,
    );
    if (endDate < new Date(existing.startDate)) {
      throw new BadRequestException({
        code: 'invalid_end_date',
        message: 'La fecha de baja no puede ser anterior al inicio del contrato',
      });
    }
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          status: 'ending',
          endingRequestedAt: new Date(),
          endDate,
          endDateBeforeEnding: existing.endDate,
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'ending_requested',
          payload: { endDate: endDate.toISOString().slice(0, 10) },
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.ending_requested',
      entityType: 'Contract',
      entityId: updated.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(updated);
  }

  // -------------------------------------------------------------------------
  // Move-out self-service (portal del inquilino)
  // -------------------------------------------------------------------------

  /**
   * Fecha de baja que pide el inquilino: debe respetar el preaviso desde hoy
   * (en la hora del local) y, si su contrato se firmó con la baja a final de
   * mes, se lleva al final de su mes (pide el 20 de diciembre → se va el 31).
   */
  private async customerMoveOutDate(
    tenantId: string,
    contract: { unitId: string; cancellationNoticeDays: number; moveOutEndOfMonth: boolean | null },
    requestedYmd: string,
  ): Promise<Date> {
    const today = await this.todayAtUnit(tenantId, contract.unitId);
    const endOfMonth = contract.moveOutEndOfMonth === true;
    const todayYmd = today.toISOString().slice(0, 10);
    const minDate = earliestMoveOutDate({
      today: todayYmd,
      noticeDays: contract.cancellationNoticeDays,
      endOfMonth: false,
    });
    if (requestedYmd.slice(0, 10) < minDate) {
      throw new BadRequestException({
        code: 'notice_period_not_met',
        message: `La baja requiere un preaviso de ${contract.cancellationNoticeDays} días`,
        details: {
          minEndDate: earliestMoveOutDate({
            today: todayYmd,
            noticeDays: contract.cancellationNoticeDays,
            endOfMonth,
          }),
        },
      });
    }
    return new Date(`${effectiveMoveOutDate(requestedYmd, endOfMonth)}T00:00:00Z`);
  }

  private toPortalDto(
    row: {
      id: string;
      contractNumber: string;
      status: string;
      startDate: Date;
      endDate: Date | null;
      priceMonthly: unknown;
      discountAmount: unknown;
      cancellationNoticeDays: number;
      endingRequestedAt: Date | null;
      depositAmount: unknown;
      depositStatus: string;
      freeMonthsRemaining: number;
      insurancePlanId: string | null;
      insurancePrice: unknown;
      signedPdfUrl: string | null;
      unit: {
        code: string;
        facilityId: string;
        facility: { name: string };
        unitType: { propertyKind: string } | null;
      };
      insurancePlan: { name: string; taxRate: unknown } | null;
      preOpening: boolean;
      preOpeningDateConfirmed: boolean;
      preOpeningDeadline: Date | null;
      preOpeningStartedAt: Date | null;
      moveOutEndOfMonth: boolean | null;
      withdrawalDeadline: Date | null;
      withdrawnAt: Date | null;
    },
    overlocked = false,
  ): PortalContractDto {
    const base = Number(row.priceMonthly);
    const discount = Number(row.discountAmount);
    const effectivePrice = this.pricing.computeEffectivePrice({ base, discount });
    const rentVat = rentTax(row.unit.unitType?.propertyKind).taxRate;
    const insurance = row.insurancePrice != null ? Number(row.insurancePrice) : null;
    return {
      id: row.id,
      contractNumber: row.contractNumber,
      unitCode: row.unit.code,
      facilityId: row.unit.facilityId,
      facilityName: row.unit.facility.name,
      status: row.status as ContractStatusValue,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate?.toISOString().slice(0, 10) ?? null,
      priceMonthly: base,
      effectivePrice,
      effectivePriceWithVat: round2(effectivePrice * (1 + rentVat / 100)),
      cancellationNoticeDays: row.cancellationNoticeDays,
      moveOutEndOfMonth: row.moveOutEndOfMonth === true,
      withdrawalDeadline: portalWithdrawalDeadline(row),
      endingRequestedAt: row.endingRequestedAt?.toISOString() ?? null,
      depositAmount: Number(row.depositAmount),
      depositStatus: row.depositStatus as PortalContractDto['depositStatus'],
      discountAmount: discount,
      freeMonthsRemaining: row.freeMonthsRemaining,
      insurancePlanId: row.insurancePlanId,
      insurancePlanName: row.insurancePlan?.name ?? null,
      insurancePrice: insurance,
      insurancePriceWithVat:
        insurance != null
          ? round2(insurance * (1 + Number(row.insurancePlan?.taxRate ?? 21) / 100))
          : null,
      hasSignedPdf: !!row.signedPdfUrl,
      overlocked,
      preOpening: preOpeningDto(row),
    };
  }

  /** Contratos active/ending del inquilino (para el portal). */
  async listForCustomer(tenantId: string, customerId: string): Promise<PortalContractDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.contract.findMany({
        where: { tenantId, customerId, deletedAt: null, status: { in: ['active', 'ending'] } },
        orderBy: { startDate: 'desc' },
        include: {
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true, taxRate: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      // Trasteros con candado por impago (expediente overlock no cerrado).
      const overlocked = await tx.delinquencyCase.findMany({
        where: {
          tenantId,
          contractId: { in: rows.map((r) => r.id) },
          status: { notIn: CLOSED_CASE_STATUSES },
          overlockedAt: { not: null },
        },
        select: { contractId: true },
      });
      const overlockedSet = new Set(overlocked.map((o) => o.contractId));
      return rows.map((r) => this.toPortalDto(r, overlockedSet.has(r.id)));
    }, tenantId);
  }

  /**
   * El inquilino solicita la baja desde el portal: deja el contrato en `ending`
   * con la fecha de salida (respetando el preaviso) y emite el evento para que
   * el staff reciba la notificación y se dispare la encuesta de salida.
   */
  async requestEndByCustomer(args: {
    tenantId: string;
    customerId: string;
    contractId: string;
    facilityScope?: string[] | null;
    endDate: string;
  }): Promise<PortalContractDto> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: {
            id: args.contractId,
            customerId: args.customerId,
            tenantId: args.tenantId,
            deletedAt: null,
          },
        }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (existing.status !== 'active') {
      throw new BadRequestException({
        code: 'contract_not_active',
        message: 'Solo puedes solicitar la baja de un contrato activo',
      });
    }
    if (isPendingPreOpening(existing)) {
      throw new BadRequestException({
        code: 'pre_opening_not_started',
        message: 'La reserva aún no ha empezado: cancélala como reserva antes de la apertura',
      });
    }
    const requested = await this.customerMoveOutDate(args.tenantId, existing, args.endDate);

    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          status: 'ending',
          endDate: requested,
          endingRequestedAt: new Date(),
          endDateBeforeEnding: existing.endDate,
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
              email: true,
              phone: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true, taxRate: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'ending_requested',
          payload: {
            requestedEndDate: args.endDate,
            endDate: requested.toISOString().slice(0, 10),
            channel: 'portal',
          },
          createdByUserId: null,
        },
      });
      return row;
    }, args.tenantId);

    const c = updated.customer;
    const displayName =
      c.customerType === 'business'
        ? (c.companyName ?? 'Empresa')
        : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
    const payload: DomainEventPayload = {
      tenantId: args.tenantId,
      entityType: 'contract',
      entityId: updated.id,
      recipientEmail: c.email ?? null,
      recipientPhone: c.phone ?? null,
      customerId: updated.customerId,
      scope: {
        customer: { firstName: c.firstName ?? '', displayName, email: c.email ?? '' },
        contract: { number: updated.contractNumber, endDate: requested.toISOString().slice(0, 10) },
        unit: { code: updated.unit.code },
        facility: { name: updated.unit.facility.name },
      },
    };
    this.eventBus.emit(DOMAIN_EVENTS.contract_move_out_requested, payload);

    return this.toPortalDto(updated);
  }

  /**
   * El inquilino cambia la fecha de una baja ya pedida (sin cancelarla y
   * volver a pedirla). La nueva fecha respeta el mismo preaviso desde hoy.
   */
  async changeMoveOutDateByCustomer(args: {
    tenantId: string;
    customerId: string;
    contractId: string;
    endDate: string;
  }): Promise<PortalContractDto> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: {
            id: args.contractId,
            customerId: args.customerId,
            tenantId: args.tenantId,
            deletedAt: null,
          },
        }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_ending',
        message: 'Solo puedes cambiar la fecha de una baja que esté en curso',
      });
    }
    const requested = await this.customerMoveOutDate(args.tenantId, existing, args.endDate);
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { endDate: requested },
        include: {
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true, taxRate: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'ending_requested',
          payload: {
            requestedEndDate: requested.toISOString().slice(0, 10),
            previousEndDate: existing.endDate?.toISOString().slice(0, 10) ?? null,
            channel: 'portal',
            reason: 'move_out_date_changed',
          },
          createdByUserId: null,
        },
      });
      return row;
    }, args.tenantId);
    return this.toPortalDto(updated);
  }

  /**
   * El inquilino cancela una baja en curso (contrato en `ending`): vuelve a
   * `active`, limpiando la fecha de salida y la marca de solicitud.
   *
   * Es seguro porque en el estado `ending` todavía no ha ocurrido nada
   * irreversible (el cierre real —liberar la unidad, liquidar fianza— sucede en
   * `end`). Solo revierte contratos en `ending`; cualquier otro estado → 400.
   */
  async cancelMoveOutByCustomer(args: {
    tenantId: string;
    customerId: string;
    contractId: string;
  }): Promise<PortalContractDto> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: {
            id: args.contractId,
            customerId: args.customerId,
            tenantId: args.tenantId,
            deletedAt: null,
          },
        }),
      args.tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    if (existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_ending',
        message: 'Solo puedes cancelar una baja que esté en curso',
      });
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          status: 'active',
          // Vuelve la fecha de fin que tenía antes de pedir la baja (si sigue por delante).
          endDate: endDateAfterCancellingMoveOut(existing.endDateBeforeEnding),
          endDateBeforeEnding: null,
          endingRequestedAt: null,
        },
        include: {
          customer: {
            select: { firstName: true, lastName: true, companyName: true, customerType: true },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true, taxRate: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'resumed',
          payload: { channel: 'portal', reason: 'move_out_cancelled' },
          createdByUserId: null,
        },
      });
      return row;
    }, args.tenantId);

    // El equipo pudo estar preparando el check-out: hay que avisarle.
    const c = updated.customer;
    const cancelled: MoveOutCancelledPayload = {
      tenantId: args.tenantId,
      contractId: updated.id,
      contractNumber: updated.contractNumber,
      customerName:
        c.customerType === 'business'
          ? (c.companyName ?? 'Empresa')
          : [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente',
      reason: 'portal',
    };
    this.eventBus.emit(DOMAIN_EVENTS.contract_move_out_cancelled, cancelled);

    return this.toPortalDto(updated);
  }

  async end(args: {
    tenantId: string;
    /** null = lo finaliza el sistema (baja que llegó a su fecha). */
    userId: string | null;
    contractId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'ended');
    if (isPendingPreOpening(existing)) {
      throw new BadRequestException({
        code: 'pre_opening_not_started',
        message: 'La reserva aún no ha empezado: cancélala como reserva antes de la apertura',
      });
    }
    // Cerrar antes de la fecha de fin: la fecha real es hoy (la ficha y el abono
    // de un prepago la usan).
    const today = await this.todayAtUnit(args.tenantId, existing.unitId);
    const effectiveEnd = !existing.endDate || existing.endDate > today ? today : existing.endDate;
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          status: 'ended',
          endedAt: new Date(),
          endDate: effectiveEnd,
          ...NO_SCHEDULED_CHANGES,
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'ended',
          payload: {},
          createdByUserId: args.userId,
        },
      });
      // Liberar el unit -> available. Con un expediente de impago abierto los
      // bienes siguen dentro: el trastero queda bloqueado (fuera de la venta)
      // hasta que se vacíe.
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
      if (unit.status === 'occupied') {
        await this.releaseOrHoldUnit(
          tx,
          args,
          existing.unitId,
          args.contractId,
          unit.status,
          `Contrato ${row.contractNumber} finalizado`,
        );
      }
      await this.releaseScheduledUnit(
        tx,
        args,
        existing,
        `Contrato ${row.contractNumber} finalizado`,
      );
      // Cancelar el dunning pendiente de las facturas de este contrato: un
      // contrato finalizado no debe seguir recibiendo recordatorios de impago
      // programados (la deuda real se gestiona por Cartera/overlock).
      await this.cancelScheduledDunning(tx, args.tenantId, args.contractId, 'Contrato finalizado');
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.ended',
      entityType: 'Contract',
      entityId: updated.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    await this.creditPrepaidMonths(args, effectiveEnd);
    await this.emitContractEnded(args.tenantId, updated);
    this.emitScheduledUnitFreed(args.tenantId, existing);
    return this.toDto(updated);
  }

  /** Devuelve a la venta el trastero de un traslado programado que no se hará. */
  private async releaseScheduledUnit(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; userId: string | null; meta: RequestMeta },
    contract: { id: string; scheduledUnitId: string | null },
    reason: string,
  ): Promise<void> {
    if (!contract.scheduledUnitId) return;
    await releaseReservedUnit(tx, {
      tenantId: ctx.tenantId,
      unitId: contract.scheduledUnitId,
      userId: ctx.userId,
      contractId: contract.id,
      reason,
    });
  }

  private emitScheduledUnitFreed(
    tenantId: string,
    contract: { scheduledUnitId: string | null },
  ): void {
    if (!contract.scheduledUnitId) return;
    this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
      tenantId,
      unitId: contract.scheduledUnitId,
    } satisfies UnitAvailablePayload);
  }

  /**
   * Cambios de cuota y traslados que llegan a su fecha. Los programó una persona:
   * aquí solo se aplican. Cada uno va por separado. Lo lanza el cron diario.
   */
  async applyScheduledChanges(now = new Date()): Promise<{ prices: number; moves: number }> {
    const today = todayInTimezone('Europe/Madrid', now);
    const live = { status: { in: ['active', 'ending'] as ContractStatus[] }, deletedAt: null };
    const [prices, moves] = await Promise.all([
      this.admin.contract.findMany({
        where: { ...live, scheduledPriceDate: { lte: today } },
        select: {
          id: true,
          tenantId: true,
          scheduledPrice: true,
          scheduledPriceReason: true,
        },
        take: 500,
      }),
      this.admin.contract.findMany({
        where: { ...live, scheduledUnitDate: { lte: today } },
        select: {
          id: true,
          tenantId: true,
          scheduledUnitId: true,
          scheduledUnitPrice: true,
          scheduledUnitProrate: true,
        },
        take: 500,
      }),
    ]);
    let appliedPrices = 0;
    for (const c of prices) {
      try {
        await this.changePrice({
          tenantId: c.tenantId,
          userId: null,
          contractId: c.id,
          input: {
            priceMonthly: Number(c.scheduledPrice),
            reason: c.scheduledPriceReason ?? 'Cambio de cuota programado',
          },
          meta: {},
        });
        appliedPrices += 1;
      } catch (err) {
        this.logger.warn(`[scheduled-price] contrato ${c.id}: ${String(err)}`);
      }
    }
    let appliedMoves = 0;
    for (const c of moves) {
      if (!c.scheduledUnitId) continue;
      try {
        await this.changeUnit({
          tenantId: c.tenantId,
          userId: null,
          contractId: c.id,
          newUnitId: c.scheduledUnitId,
          ...(c.scheduledUnitPrice != null ? { newPrice: Number(c.scheduledUnitPrice) } : {}),
          prorate: c.scheduledUnitProrate,
          meta: {},
        });
        appliedMoves += 1;
      } catch (err) {
        // Sin aplicar, alguien tiene que mirarlo: el trastero sigue reservado.
        this.logger.warn(`[scheduled-move] contrato ${c.id}: ${String(err)}`);
        await this.admin.notification
          .create({
            data: {
              tenantId: c.tenantId,
              type: 'contract.scheduled_move_failed',
              title: 'Un traslado programado no se ha podido hacer',
              body: 'Revísalo en la ficha del contrato: puedes anularlo o hacerlo a mano.',
              link: `/contracts/${c.id}`,
            },
          })
          .catch(() => undefined);
      }
    }
    return { prices: appliedPrices, moves: appliedMoves };
  }

  /** Anula el cambio de cuota programado. */
  async cancelScheduledPrice(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: { scheduledPrice: null, scheduledPriceDate: null, scheduledPriceReason: null },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.scheduled_price_cancelled',
      entityType: 'Contract',
      entityId: args.contractId,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.detail(args.tenantId, args.contractId, args.facilityScope);
  }

  /** Anula el traslado programado y devuelve a la venta el trastero de destino. */
  async cancelScheduledMove(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    await this.prisma.withTenant(async (tx) => {
      await this.releaseScheduledUnit(tx, args, existing, 'Traslado programado anulado');
      await tx.contract.update({
        where: { id: args.contractId },
        data: {
          scheduledUnitId: null,
          scheduledUnitDate: null,
          scheduledUnitPrice: null,
          scheduledUnitProrate: false,
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.scheduled_move_cancelled',
      entityType: 'Contract',
      entityId: args.contractId,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    this.emitScheduledUnitFreed(args.tenantId, existing);
    return this.detail(args.tenantId, args.contractId, args.facilityScope);
  }

  /**
   * Baja de un contrato PREPAGADO: abono (rectificativa en borrador) de los
   * meses completos no consumidos. Best-effort: no bloquea la baja.
   */
  private async creditPrepaidMonths(
    args: { tenantId: string; userId: string | null; contractId: string; meta: RequestMeta },
    endDate: Date,
  ): Promise<void> {
    try {
      await this.createPrepayCreditNote({
        tenantId: args.tenantId,
        userId: args.userId,
        contractId: args.contractId,
        endDate,
        meta: args.meta,
      });
    } catch (err) {
      this.logger.warn(
        `[prepay-credit] contrato=${args.contractId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Bajas que ya llegaron a su fecha: el día siguiente a la fecha de fin el
   * contrato se finaliza solo (libera el trastero, revoca el acceso si no le
   * queda otro contrato y avisa a la lista de espera), si el tenant no lo ha
   * desactivado. Se avisa al equipo para que haga el check-out y liquide la
   * fianza. Cross-tenant; lo lanza el cron diario.
   */
  /**
   * Contratos activos cuya fecha de fin ya pasó. Con renovación automática se
   * prorrogan por el mismo plazo que tenían (y siguen facturando); sin ella
   * pasan a «en baja» con esa fecha, y `autoEndDue` los cierra. Antes se
   * quedaban activos, con el trastero ocupado y el acceso abierto, sin facturar.
   */
  async autoRenewDue(now = new Date()): Promise<{ renewed: number; ending: number }> {
    const today = todayInTimezone('Europe/Madrid', now);
    const due = await this.admin.contract.findMany({
      where: { status: 'active', deletedAt: null, endDate: { lt: today } },
      select: {
        id: true,
        tenantId: true,
        startDate: true,
        endDate: true,
        termMonths: true,
        autoRenew: true,
        contractNumber: true,
        unit: { select: { facilityId: true } },
      },
      take: 500,
    });
    let renewed = 0;
    let ending = 0;
    for (const c of due) {
      if (!c.endDate) continue;
      try {
        if (c.autoRenew) {
          // Siempre el plazo original: el de la primera prórroga queda guardado.
          const months = c.termMonths ?? termMonths(c.startDate, c.endDate);
          let newEnd = this.addMonths(c.endDate, months);
          let guard = 0;
          while (newEnd < today && guard < 120) {
            newEnd = this.addMonths(newEnd, months);
            guard += 1;
          }
          await this.prisma.withTenant(async (tx) => {
            const moved = await tx.contract.updateMany({
              where: { id: c.id, status: 'active', endDate: c.endDate },
              data: { endDate: newEnd, termMonths: months, endingSoonNotifiedAt: null },
            });
            if (moved.count === 0) return;
            await tx.contractEvent.create({
              data: {
                tenantId: c.tenantId,
                contractId: c.id,
                eventType: 'note_added',
                payload: {
                  event: 'auto_renewed',
                  months,
                  newEndDate: newEnd.toISOString().slice(0, 10),
                },
                createdByUserId: null,
              },
            });
          }, c.tenantId);
          this.eventBus.emit(DOMAIN_EVENTS.contract_renewed, {
            tenantId: c.tenantId,
            contractId: c.id,
            newEndDate: newEnd,
          } satisfies ContractRenewedPayload);
          renewed += 1;
        } else {
          await this.prisma.withTenant(async (tx) => {
            const moved = await tx.contract.updateMany({
              where: { id: c.id, status: 'active', endDate: c.endDate },
              data: { status: 'ending', endingRequestedAt: new Date() },
            });
            if (moved.count === 0) return;
            await tx.contractEvent.create({
              data: {
                tenantId: c.tenantId,
                contractId: c.id,
                eventType: 'ending_requested',
                payload: {
                  reason: 'term_reached',
                  endDate: c.endDate!.toISOString().slice(0, 10),
                },
                createdByUserId: null,
              },
            });
          }, c.tenantId);
          ending += 1;
        }
      } catch (err) {
        this.logger.warn(
          `[auto-renew] contrato ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { renewed, ending };
  }

  async autoEndDue(now = new Date()): Promise<{ ended: number }> {
    const today = todayInTimezone('Europe/Madrid', now);
    const due = await this.admin.contract.findMany({
      where: {
        status: 'ending',
        deletedAt: null,
        endDate: { lt: today },
        tenant: { autoEndContracts: true, deletedAt: null },
      },
      select: {
        id: true,
        tenantId: true,
        contractNumber: true,
        unit: { select: { facilityId: true } },
      },
      take: 500,
    });
    let ended = 0;
    for (const c of due) {
      try {
        await this.end({ tenantId: c.tenantId, userId: null, contractId: c.id, meta: {} });
        ended += 1;
        await this.admin.notification
          .create({
            data: {
              tenantId: c.tenantId,
              type: 'contract.auto_ended',
              title: `Contrato ${c.contractNumber} finalizado`,
              body: 'Ha llegado la fecha de la baja: el trastero ya está libre y el acceso del inquilino, revocado. Haz el check-out y liquida la fianza.',
              link: `/contracts/${c.id}`,
              facilityId: c.unit.facilityId,
            },
          })
          .catch(() => undefined);
      } catch (err) {
        this.logger.warn(
          `[auto-end] contrato ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { ended };
  }

  /**
   * Genera la rectificativa (R1, por diferencias, en BORRADOR) que abona lo
   * pagado por adelantado y no usado (ver `prepaidCreditFor`). El staff la
   * revisa, la emite y devuelve el importe a mano (no se reembolsa por
   * pasarela). Idempotente: si la factura ya tiene una rectificativa viva, no
   * hace nada.
   */
  private async createPrepayCreditNote(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    endDate: Date;
    meta: RequestMeta;
  }): Promise<void> {
    const prepaid = await this.prepaidCreditFor(args.tenantId, args.contractId, args.endDate);
    if (!prepaid) return;
    const alreadyCredited = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.count({
          where: { rectifiesInvoiceId: prepaid.invoiceId, status: { not: 'cancelled' } },
        }),
      args.tenantId,
    );
    if (alreadyCredited > 0) return;
    const { unused, months } = prepaid;
    const items = prepaid.lines.map((l) => ({
      description: `Abono baja anticipada (${unused} de ${months} meses sin usar) — ${l.description}`,
      quantity: 1,
      unitPrice: -l.base,
      taxRate: l.taxRate,
      taxCategory: l.taxCategory as InvoiceTaxCategory,
      relatedContractId: args.contractId,
    }));

    const credit = await this.invoices.rectify({
      originalInvoiceId: prepaid.invoiceId,
      tenantId: args.tenantId,
      userId: args.userId,
      input: {
        rectificationType: 'R1',
        reason: `Baja anticipada de un periodo pagado por adelantado: abono de ${unused} de ${months} meses sin usar; los usados se cobran a la cuota mensual, sin el descuento del prepago`,
        correctionMethod: 'by_differences',
        items,
      },
      meta: args.meta,
    });
    await this.prisma.withTenant(
      (tx) =>
        tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'note_added',
            payload: {
              event: 'prepay_credit_note',
              invoiceId: credit.id,
              originalInvoiceId: prepaid.invoiceId,
              unusedMonths: unused,
              total: credit.total,
            },
            createdByUserId: args.userId,
          },
        }),
      args.tenantId,
    );
  }

  /**
   * Emite `domain.contract_ended` tras finalizar/cancelar un contrato vivo. Lo
   * escuchan las automatizaciones de fin de contrato y `AccessIntegrationsService`
   * (revoca las credenciales de acceso si al inquilino no le queda ningún
   * contrato activo). Antes NO se emitía → PIN de acceso vivo tras la baja.
   */
  private async emitContractEnded(
    tenantId: string,
    contract: {
      id: string;
      customerId: string;
      contractNumber: string;
      priceMonthly: Prisma.Decimal;
      startDate: Date;
      endDate: Date | null;
      unitId: string;
      unit: { code: string; facility: { name: string } };
    },
  ): Promise<void> {
    const customer = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findUnique({
          where: { id: contract.customerId },
          select: {
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
            phone: true,
          },
        }),
      tenantId,
    );
    const displayName =
      customer?.companyName?.trim() ||
      `${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`.trim();
    const payload: DomainEventPayload = {
      tenantId,
      entityType: 'contract',
      entityId: contract.id,
      recipientEmail: customer?.email ?? null,
      recipientPhone: customer?.phone ?? null,
      customerId: contract.customerId,
      scope: {
        customer: {
          firstName: customer?.firstName ?? '',
          lastName: customer?.lastName ?? '',
          displayName,
          email: customer?.email ?? '',
        },
        contract: {
          number: contract.contractNumber,
          priceMonthly: Number(contract.priceMonthly).toFixed(2),
          startDate: contract.startDate.toISOString().slice(0, 10),
          endDate: contract.endDate?.toISOString().slice(0, 10) ?? '',
        },
        unit: { code: contract.unit.code },
        facility: { name: contract.unit.facility.name },
      },
    };
    this.eventBus.emit(DOMAIN_EVENTS.contract_ended, payload);
    // Lo pedido sobre un contrato que ya no existe no se puede atender.
    await this.prisma.withTenant(
      (tx) =>
        tx.unitChangeRequest.updateMany({
          where: { contractId: contract.id, status: 'pending' },
          data: {
            status: 'rejected',
            resolutionNote: 'El contrato ha terminado',
            handledAt: new Date(),
          },
        }),
      tenantId,
    );
    // El trastero queda libre → avisar a la lista de espera de su tipo.
    this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
      tenantId,
      unitId: contract.unitId,
    } satisfies UnitAvailablePayload);
  }

  /**
   * Cancela las acciones de dunning aún `scheduled` de las facturas de un
   * contrato al finalizarlo/cancelarlo → un contrato dado de baja no sigue
   * recibiendo recordatorios de impago programados (la deuda real se gestiona
   * por Cartera/overlock). No toca las ya `executed`/`failed` (rastro histórico).
   */
  private async cancelScheduledDunning(
    tx: Prisma.TransactionClient,
    tenantId: string,
    contractId: string,
    notes: string,
  ): Promise<void> {
    const invoices = await tx.invoice.findMany({
      where: { contractId, deletedAt: null },
      select: { id: true },
    });
    if (invoices.length === 0) return;
    await tx.dunningAction.updateMany({
      where: {
        tenantId,
        invoiceId: { in: invoices.map((i) => i.id) },
        status: 'scheduled',
      },
      data: { status: 'cancelled', notes },
    });
  }

  /**
   * Liquida la fianza retenida al finalizar el contrato: devuelve total o
   * parcialmente el depósito, reteniendo el resto por daños/deuda (con motivo).
   * Transiciona `depositStatus` held → returned/partially_returned. La devolución
   * NO es una factura (la fianza es una garantía sin IVA); se registra en el
   * contrato + timeline + audit. El operador decide cuánto devolver (viendo la
   * deuda pendiente en la UI). Reutiliza el evento `note_added` con payload
   * tipado (el enum no tiene `deposit_settled`, patrón del proyecto).
   */
  /** Cómo se cobra la fianza (online con la 1ª factura o en el local). Solo antes de firmar. */
  async setDepositPaymentMethod(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    method: 'online' | 'cash';
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status !== 'draft') {
      throw new BadRequestException({
        code: 'contract_already_signed',
        message:
          'Solo se puede cambiar antes de firmar. Después, cobra la fianza desde «Registrar cobro».',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: existing.id },
          data: { depositPaymentMethod: args.method },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.deposit_payment_method_changed',
      entityType: 'Contract',
      entityId: existing.id,
      changes: { method: args.method },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope));
  }

  /**
   * Registra el cobro de la fianza en el local (efectivo, TPV, transferencia…): usa
   * su justificante o lo crea si aún no existe (p. ej. contrato firmado en el
   * panel) y lo marca cobrado por el importe completo.
   */
  async collectDeposit(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    methodType: 'cash' | 'card' | 'bank_transfer' | 'bizum' | 'other';
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    const deposit = Number(existing.depositAmount);
    if (deposit <= 0) {
      throw new BadRequestException({
        code: 'no_deposit',
        message: 'Este contrato no tiene fianza',
      });
    }
    if (existing.status === 'cancelled' || existing.status === 'ended') {
      throw new BadRequestException({
        code: 'contract_closed',
        message: 'El contrato ya no está vivo',
      });
    }
    let receipt = existing.invoices?.[0] ?? null;
    if (receipt?.status === 'paid') {
      throw new ConflictException({
        code: 'deposit_already_collected',
        message: 'La fianza ya está cobrada',
      });
    }
    if (!receipt) {
      const created = await this.invoices.createDepositReceipt({
        tenantId: args.tenantId,
        userId: args.userId,
        contractId: existing.id,
        customerId: existing.customerId,
        contractNumber: existing.contractNumber,
        amount: deposit,
        dueDate: null,
        bundledWithInvoiceId: null,
      });
      receipt = { id: created.id, invoiceNumber: created.invoiceNumber, status: created.status };
    }
    const doc = await this.invoices.detail(args.tenantId, receipt.id);
    await this.invoices.markPaidManually({
      tenantId: args.tenantId,
      userId: args.userId,
      invoiceId: receipt.id,
      input: { amount: doc.amountPending, methodType: args.methodType },
      meta: args.meta,
    });
    return this.toDto(await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope));
  }

  async settleDeposit(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    input: SettleDepositInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
    /** Cancelación de una reserva anticipada: cierra la fianza aunque no llegara a cobrarse. */
    closeUncollected?: boolean;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.depositStatus !== 'held') {
      throw new BadRequestException({
        code: 'deposit_not_held',
        message: 'La fianza no está retenida (nada que liquidar)',
      });
    }
    // Solo se liquida lo cobrado. Un contrato cerrado sin justificante pendiente
    // viene de antes de los justificantes: se puede cerrar igual.
    const collected = await this.prisma.withTenant(
      (tx) => depositWasCollected(tx, existing.id),
      args.tenantId,
    );
    const legacyClosed =
      (existing.status === 'ended' || existing.status === 'cancelled') && !existing.invoices?.[0];
    if (!collected && !legacyClosed && !args.closeUncollected) {
      throw new BadRequestException({
        code: 'deposit_not_collected',
        message: 'La fianza aún no se ha cobrado: no hay nada que devolver ni retener',
      });
    }
    const deposit = Number(existing.depositAmount);
    const returned = args.input.returnedAmount;
    if (returned < 0 || isGreaterThan(returned, deposit)) {
      throw new BadRequestException({
        code: 'invalid_return_amount',
        message: `El importe a devolver debe estar entre 0 y ${deposit.toFixed(2)} €`,
      });
    }
    const retained = subtractAmounts(deposit, returned);
    const fullyReturned = isAtLeast(returned, deposit);
    const newStatus: 'returned' | 'partially_returned' = fullyReturned
      ? 'returned'
      : 'partially_returned';
    // Si se retiene algo, el motivo es obligatorio (trazabilidad legal).
    if (isGreaterThan(retained, 0) && !args.input.retentionReason?.trim()) {
      throw new BadRequestException({
        code: 'retention_reason_required',
        message: 'Indica el motivo de la retención (daños, deuda pendiente, …)',
      });
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      // Fianza devuelta en efectivo: sale del cajón de ese día (no con la caja
      // ya cerrada; si hace falta, se reabre el cierre).
      if (args.input.returnMethod === 'cash' && isGreaterThan(returned, 0)) {
        await assertCashDayOpen(tx, {
          tenantId: args.tenantId,
          facilityId: existing.unit?.facilityId ?? null,
          at: [args.input.returnedOn ? new Date(`${args.input.returnedOn}T12:00:00Z`) : new Date()],
          what: 'una fianza devuelta en efectivo',
        });
      }
      // Claim atómico: la condición `depositStatus:'held'` va en el WHERE del
      // UPDATE (no en un SELECT previo) — dos liquidaciones concurrentes de
      // la misma fianza (doble clic, dos pestañas) solo dejan pasar a UNA; la
      // otra ve `count:0` y recibe 409 en vez de pisar en silencio el importe
      // ya liquidado (mismo patrón que `CollectionsService.completeDisposal`).
      const claim = await tx.contract.updateMany({
        where: { id: args.contractId, depositStatus: 'held' },
        data: {
          depositStatus: newStatus,
          depositReturnedAmount: returned,
          depositSettledAt: new Date(),
          depositRetentionReason: isGreaterThan(retained, 0)
            ? (args.input.retentionReason?.trim() ?? null)
            : null,
          depositReturnMethod: args.input.returnMethod ?? null,
          depositReturnedOn: args.input.returnedOn
            ? new Date(`${args.input.returnedOn}T00:00:00Z`)
            : null,
          depositReturnReference: args.input.returnReference?.trim() || null,
        },
      });
      if (claim.count === 0) {
        throw new ConflictException({
          code: 'deposit_already_settled',
          message: 'La fianza ya se ha liquidado (quizá desde otra pestaña)',
        });
      }
      const row = await tx.contract.findUniqueOrThrow({
        where: { id: args.contractId },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'note_added',
          payload: {
            event: 'deposit_settled',
            deposit,
            returned,
            retained,
            retentionReason: args.input.retentionReason?.trim() ?? null,
          },
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.deposit_settled',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { deposit, returned, retained, status: newStatus },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    const applied = args.input.applyToInvoices
      ? await this.applyRetainedDeposit(args, retained)
      : 0;
    if (args.input.notifyCustomer) {
      this.eventBus.emit(DOMAIN_EVENTS.contract_deposit_settled, {
        tenantId: args.tenantId,
        contractId: args.contractId,
        deposit,
        returned,
        retained,
        applied,
        reason: args.input.retentionReason?.trim() || null,
      } satisfies ContractDepositSettledPayload);
    }
    return applied > 0
      ? this.detail(args.tenantId, args.contractId, args.facilityScope)
      : this.toDto(updated);
  }

  /**
   * Lo retenido salda las facturas pendientes del contrato, de la más antigua a
   * la más reciente. Devuelve lo aplicado: el resto sigue retenido.
   */
  private async applyRetainedDeposit(
    args: {
      tenantId: string;
      userId: string | null;
      contractId: string;
      meta: RequestMeta;
    },
    retained: number,
  ): Promise<number> {
    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            contractId: args.contractId,
            kind: 'invoice',
            status: { in: ['issued', 'overdue'] },
            deletedAt: null,
          },
          orderBy: { issueDate: 'asc' },
          select: { id: true, total: true, amountPaid: true },
        }),
      args.tenantId,
    );
    let funds = toCents(retained);
    let appliedCents = 0;
    for (const inv of invoices) {
      if (funds <= 0) break;
      const pay = Math.min(toCents(Number(inv.total) - Number(inv.amountPaid)), funds);
      if (pay <= 0) continue;
      await this.invoices.markPaidManually({
        tenantId: args.tenantId,
        userId: args.userId,
        invoiceId: inv.id,
        input: {
          amount: pay / 100,
          // No es dinero nuevo (entró al cobrar la fianza): no cuenta en la caja.
          methodType: 'deposit',
          notes: 'Aplicado de la fianza retenida',
          allowPartialNonCash: true,
          overridePaymentInFlight: true,
          allowInSepaRemittance: true,
        },
        meta: args.meta,
      });
      funds -= pay;
      appliedCents += pay;
    }
    if (appliedCents > 0) {
      await this.prisma.withTenant(
        (tx) =>
          tx.contract.update({
            where: { id: args.contractId },
            data: { depositAppliedAmount: appliedCents / 100 },
          }),
        args.tenantId,
      );
    }
    return appliedCents / 100;
  }

  async cancel(args: {
    tenantId: string;
    /** `null` cuando lo lanza un proceso automático (cron de bookings impagados). */
    userId: string | null;
    contractId: string;
    facilityScope?: string[] | null;
    input: CancelContractInput;
    meta: RequestMeta;
    /** El desistimiento ya devuelve lo pagado por adelantado: sin abono aparte. */
    skipPrepaidCredit?: boolean;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    this.assertTransition(existing.status, 'cancelled');
    // Cancelar un contrato VIVO (no un draft) equivale a una baja: hay que
    // revocar accesos y disparar las automatizaciones de fin de contrato.
    const wasLive = existing.status === 'active' || existing.status === 'ending';
    let released = false;
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: { status: 'cancelled', cancelledAt: new Date(), ...NO_SCHEDULED_CHANGES },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'cancelled',
          payload: { reason: args.input.reason?.trim() || null },
          createdByUserId: args.userId,
        },
      });
      // Si el contrato estaba activo, liberar el unit.
      // Libera la unidad si estaba ocupada (contrato firmado) o RESERVADA (hold
      // de un booking self-service que se cancela sin firmar, p. ej. por impago
      // vía BookingExpiryCron). Sin liberar el `reserved`, la unidad quedaría
      // retenida para siempre.
      // Solo si lo retenía este contrato: un borrador cualquiera sobre un trastero
      // reservado para otra persona no lo devuelve a la venta.
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
      const held =
        wasLive ||
        !!existing.firstPaymentDeadline ||
        existing.preOpening ||
        (await tx.reservation.count({ where: { convertedContractId: existing.id } })) > 0 ||
        (await tx.waitlistEntry.count({ where: { convertedContractId: existing.id } })) > 0;
      const releasable =
        (unit.status === 'reserved' &&
          held &&
          !(await unitHeldByOther(tx, { unitId: existing.unitId, contractId: existing.id }))) ||
        (wasLive && unit.status === 'occupied');
      released = releasable;
      if (releasable) {
        released = await this.releaseOrHoldUnit(
          tx,
          args,
          existing.unitId,
          existing.id,
          unit.status,
          `Contrato ${row.contractNumber} cancelado`,
        );
      }
      await this.releaseScheduledUnit(
        tx,
        args,
        existing,
        `Contrato ${row.contractNumber} cancelado`,
      );
      // Cancelar el dunning pendiente de las facturas de este contrato (ver end()).
      await this.cancelScheduledDunning(tx, args.tenantId, args.contractId, 'Contrato cancelado');
      // Un cupón de un contrato que no llegó a pagarse vuelve a quedar libre.
      await this.coupons.releaseForContractInTx(tx, args.tenantId, args.contractId);
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.cancelled',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    if (wasLive) {
      if (!args.skipPrepaidCredit) {
        await this.creditPrepaidMonths(
          args,
          await this.todayAtUnit(args.tenantId, existing.unitId),
        );
      }
      await this.emitContractEnded(args.tenantId, updated);
    } else if (released) {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId: args.tenantId,
        unitId: existing.unitId,
      } satisfies UnitAvailablePayload);
    }
    this.emitScheduledUnitFreed(args.tenantId, existing);
    return this.toDto(updated);
  }

  async changePrice(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    facilityScope?: string[] | null;
    input: ChangeContractPriceInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status !== 'active' && existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_active',
        message: 'Solo se puede cambiar el precio en contratos activos',
      });
    }
    if (isPendingPreOpening(existing)) {
      throw new BadRequestException({
        code: 'pre_opening_not_started',
        message: 'El precio de una reserva antes de la apertura queda fijado desde la reserva',
      });
    }
    if (isGreaterThan(Number(existing.discountAmount), args.input.priceMonthly)) {
      throw new BadRequestException({
        code: 'discount_too_high',
        message: 'La cuota no puede ser menor que el descuento del contrato',
      });
    }
    const today = await this.todayAtUnit(args.tenantId, existing.unitId);
    const effective = args.input.effectiveDate
      ? new Date(`${args.input.effectiveDate}T00:00:00Z`)
      : today;
    const notice = (): void => {
      if (!args.input.notifyCustomer) return;
      const monthly = subtractAmounts(args.input.priceMonthly, Number(existing.discountAmount));
      const { taxRate } = rentTax(existing.unit.unitType?.propertyKind);
      this.eventBus.emit(DOMAIN_EVENTS.contract_price_notice, {
        tenantId: args.tenantId,
        contractId: args.contractId,
        monthlyWithVat: Math.round(monthly * (100 + taxRate)) / 100,
        effectiveDate: effective,
      } satisfies ContractPriceNoticePayload);
    };
    // Con fecha futura solo queda anotado: lo aplica el proceso diario.
    if (effective > today) {
      await this.prisma.withTenant(async (tx) => {
        await tx.contract.update({
          where: { id: args.contractId },
          data: {
            scheduledPrice: args.input.priceMonthly,
            scheduledPriceDate: effective,
            scheduledPriceReason: args.input.reason,
          },
        });
        await tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'note_added',
            payload: {
              event: 'price_scheduled',
              to: args.input.priceMonthly,
              date: args.input.effectiveDate ?? null,
              reason: args.input.reason,
            },
            createdByUserId: args.userId,
          },
        });
      }, args.tenantId);
      await this.audit.write({
        tenantId: args.tenantId,
        userId: args.userId,
        action: 'contract.price_scheduled',
        entityType: 'Contract',
        entityId: args.contractId,
        changes: { to: args.input.priceMonthly, date: args.input.effectiveDate ?? null },
        ipAddress: args.meta.ipAddress ?? null,
        userAgent: args.meta.userAgent ?? null,
      });
      notice();
      return this.detail(args.tenantId, args.contractId, args.facilityScope);
    }
    const previousPrice = Number(existing.priceMonthly);
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          priceMonthly: args.input.priceMonthly,
          scheduledPrice: null,
          scheduledPriceDate: null,
          scheduledPriceReason: null,
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
          unit: {
            select: {
              code: true,
              facilityId: true,
              facility: { select: { name: true } },
              unitType: { select: { propertyKind: true } },
            },
          },
          insurancePlan: { select: { name: true } },
          owner: { select: { legalName: true } },
          invoices: DEPOSIT_RECEIPT_SELECT,
          couponRedemptions: COUPON_SELECT,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'price_changed',
          payload: {
            from: previousPrice,
            to: args.input.priceMonthly,
            reason: args.input.reason,
          },
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.price_changed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: {
        from: previousPrice,
        to: args.input.priceMonthly,
        reason: args.input.reason,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    notice();
    return this.toDto(updated);
  }

  /** Include estándar para hidratar un `ContractDto` (customer + unit + seguro). */
  private contractInclude() {
    return {
      customer: {
        select: {
          firstName: true,
          lastName: true,
          companyName: true,
          customerType: true,
        },
      },
      unit: {
        select: {
          code: true,
          facilityId: true,
          facility: { select: { name: true } },
          unitType: { select: { propertyKind: true } },
        },
      },
      insurancePlan: { select: { name: true } },
      owner: { select: { legalName: true } },
      invoices: DEPOSIT_RECEIPT_SELECT,
      couponRedemptions: COUPON_SELECT,
    } satisfies Prisma.ContractInclude;
  }

  /** Suma N meses a una fecha, conservando el fin de mes (evita desbordes de día). */
  private addMonths(date: Date, months: number): Date {
    const d = new Date(date);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
  }

  /**
   * Renueva un contrato: extiende su `endDate` N meses (desde el fin actual o
   * desde hoy si es indefinido). Si estaba `ending`, vuelve a `active` y limpia
   * la solicitud de baja. Palanca de retención (la página /renewals lo usa).
   */
  async renew(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    months: number;
    /** Cuota del nuevo periodo. */
    newPrice?: number;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status !== 'active' && existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_renewable',
        message: 'Solo se pueden renovar contratos activos o en baja',
      });
    }
    if (isPendingPreOpening(existing)) {
      throw new BadRequestException({
        code: 'pre_opening_not_started',
        message: 'La reserva aún no ha empezado: cancélala como reserva antes de la apertura',
      });
    }
    const base =
      existing.endDate && existing.endDate.getTime() > Date.now() ? existing.endDate : new Date();
    const newEndDate = this.addMonths(base, args.months);
    const updated = await this.prisma.withTenant(async (tx) => {
      const row = await tx.contract.update({
        where: { id: args.contractId },
        data: {
          endDate: newEndDate,
          // Las prórrogas automáticas siguen con el último plazo pactado.
          termMonths: args.months,
          // Renovar reactiva un contrato en baja y limpia la solicitud.
          ...(existing.status === 'ending'
            ? { status: 'active' as const, endingRequestedAt: null, endDateBeforeEnding: null }
            : {}),
          endingSoonNotifiedAt: null,
        },
        include: this.contractInclude(),
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'note_added',
          payload: { event: 'renewed', months: args.months, newEndDate: newEndDate.toISOString() },
          createdByUserId: args.userId,
        },
      });
      return row;
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.renewed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { months: args.months, newEndDate: newEndDate.toISOString().slice(0, 10) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    this.eventBus.emit(DOMAIN_EVENTS.contract_renewed, {
      tenantId: args.tenantId,
      contractId: args.contractId,
      newEndDate,
    } satisfies ContractRenewedPayload);
    // La cuota nueva vale desde el día siguiente al fin que tenía.
    if (args.newPrice != null && args.newPrice !== Number(existing.priceMonthly)) {
      const from = new Date(base.getTime() + 86_400_000).toISOString().slice(0, 10);
      return this.changePrice({
        tenantId: args.tenantId,
        userId: args.userId,
        contractId: args.contractId,
        facilityScope: args.facilityScope ?? null,
        input: {
          priceMonthly: args.newPrice,
          reason: 'Renovación del contrato',
          effectiveDate: from,
          notifyCustomer: true,
        },
        meta: args.meta,
      });
    }
    return this.toDto(updated);
  }

  /**
   * Traslado de trastero: reasigna la unidad de un contrato activo a otra
   * disponible (upsell/downsize). Libera la unidad vieja (→available), ocupa la
   * nueva (→occupied) y opcionalmente cambia la cuota. La próxima factura
   * recurrente ya sale con la unidad/precio nuevos. (Prorrateo de una factura de
   * ajuste = follow-up; hoy no se genera factura intermedia.)
   */
  async changeUnit(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    newUnitId: string;
    newPrice?: number;
    prorate?: boolean;
    /** Fecha futura: queda programado y el trastero de destino, reservado. */
    effectiveDate?: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (existing.status !== 'active' && existing.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_active',
        message: 'Solo se puede trasladar un contrato activo',
      });
    }
    const oldPrice = Number(existing.priceMonthly);
    if (args.newUnitId === existing.unitId) {
      throw new BadRequestException({
        code: 'same_unit',
        message: 'El trastero de destino es el mismo',
      });
    }
    const oldUnitId = existing.unitId;
    // Reserva anticipada sin empezar: solo otro trastero del mismo local y del
    // mismo precio, sin cambiar la cuota ni facturar ajuste.
    const pendingPreOpening = isPendingPreOpening(existing);
    if (pendingPreOpening && (args.newPrice != null || args.prorate)) {
      throw new BadRequestException({
        code: 'pre_opening_same_price',
        message: 'En una reserva antes de la apertura el precio no cambia',
      });
    }
    // El que llega a su fecha encuentra su destino reservado por él mismo.
    const fromSchedule = existing.scheduledUnitId === args.newUnitId;
    const moveDate = args.effectiveDate ? new Date(`${args.effectiveDate}T00:00:00Z`) : null;
    if (moveDate && moveDate > (await this.todayAtUnit(args.tenantId, existing.unitId))) {
      if (pendingPreOpening) {
        throw new BadRequestException({
          code: 'pre_opening_same_price',
          message: 'Antes de la apertura el cambio de trastero es inmediato',
        });
      }
      return this.scheduleMove(args, existing, moveDate);
    }
    const updated = await this.prisma
      .withTenant(async (tx) => {
        // Anti-doble-ocupación: serializa por el trastero de DESTINO (dos traslados
        // o un traslado + una firma sobre la misma unidad no se pisan).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${args.newUnitId}::text))`;
        const newUnit = await tx.unit.findFirst({
          where: { id: args.newUnitId, facility: { deletedAt: null } },
        });
        if (!newUnit) {
          throw new NotFoundException({
            code: 'unit_not_found',
            message: 'Trastero no encontrado',
          });
        }
        // El scope aplica también al trastero de DESTINO.
        assertFacilityAllowed(args.facilityScope, newUnit.facilityId);
        if (newUnit.status !== 'available' && !(fromSchedule && newUnit.status === 'reserved')) {
          throw new BadRequestException({
            code: 'unit_not_available',
            message: 'El trastero de destino no está disponible',
          });
        }
        if (
          await unitHeldByOther(tx, {
            unitId: args.newUnitId,
            contractId: existing.id,
            customerId: existing.customerId,
          })
        ) {
          throw new ConflictException({
            code: 'unit_reserved_for_other',
            message: 'El trastero de destino está reservado para otro inquilino',
          });
        }
        const ctx = { tenantId: args.tenantId, userId: args.userId, meta: args.meta };
        // Libera la vieja, ocupa la nueva.
        const oldUnit = await tx.unit.findUniqueOrThrow({ where: { id: oldUnitId } });
        if (
          pendingPreOpening &&
          (newUnit.facilityId !== oldUnit.facilityId ||
            toCents(Number(newUnit.basePriceMonthly)) !== toCents(Number(existing.priceMonthly)))
        ) {
          throw new BadRequestException({
            code: 'pre_opening_same_price',
            message:
              'Antes de la apertura solo se puede cambiar a otro trastero del mismo local y del mismo precio',
          });
        }
        if (oldUnit.status === 'occupied' || oldUnit.status === 'reserved') {
          await this.syncUnitStatus(
            tx,
            ctx,
            oldUnitId,
            oldUnit.status,
            'available',
            'Traslado: origen liberado',
          );
        }
        await this.syncUnitStatus(
          tx,
          ctx,
          args.newUnitId,
          newUnit.status,
          pendingPreOpening ? 'reserved' : 'occupied',
          pendingPreOpening ? 'Cambio de trastero reservado' : 'Traslado: destino ocupado',
        );
        // Si el trastero de destino está en otro local, el contrato pasa al
        // propietario de ese local (plan Administrador): las facturas siguientes
        // las emite quien es dueño del trastero. Lo ya facturado no cambia.
        const ownerChange =
          newUnit.facilityId !== oldUnit.facilityId
            ? {
                ownerId:
                  (
                    await tx.facility.findUnique({
                      where: { id: newUnit.facilityId },
                      select: { ownerId: true },
                    })
                  )?.ownerId ?? null,
              }
            : {};
        const row = await tx.contract.update({
          where: { id: args.contractId },
          data: {
            unitId: args.newUnitId,
            ...ownerChange,
            ...(args.newPrice != null ? { priceMonthly: args.newPrice } : {}),
            scheduledUnitId: null,
            scheduledUnitDate: null,
            scheduledUnitPrice: null,
            scheduledUnitProrate: false,
          },
          include: this.contractInclude(),
        });
        await tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'unit_changed',
            payload: {
              fromUnitId: oldUnitId,
              toUnitId: args.newUnitId,
              toUnitCode: newUnit.code,
              ...(args.newPrice != null ? { newPrice: args.newPrice } : {}),
            },
            createdByUserId: args.userId,
          },
        });
        return row;
      }, args.tenantId)
      .catch((err: unknown) => {
        // Índice único parcial: si (pese al lock) se intentara ocupar una unidad
        // que ya tiene un contrato activo → 409 claro.
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          throw new ConflictException({
            code: 'unit_not_available',
            message: 'El trastero de destino ya tiene un contrato activo',
          });
        }
        throw err;
      });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.unit_changed',
      entityType: 'Contract',
      entityId: updated.id,
      changes: { fromUnitId: oldUnitId, toUnitId: args.newUnitId, newPrice: args.newPrice ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    // El acceso del inquilino se rehace con sus trasteros (deja de abrir el
    // antiguo y abre el nuevo) y el trastero que queda libre avisa a la lista de espera.
    this.eventBus.emit(DOMAIN_EVENTS.contract_unit_changed, {
      tenantId: args.tenantId,
      contractId: updated.id,
      customerId: updated.customerId,
      fromUnitId: oldUnitId,
      toUnitId: args.newUnitId,
    } satisfies ContractUnitChangedPayload);
    this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
      tenantId: args.tenantId,
      unitId: oldUnitId,
    } satisfies UnitAvailablePayload);

    // Prorrateo del ajuste: si el traslado sube la cuota y se pidió prorate,
    // se emite una factura por la DIFERENCIA prorrateada por los días que restan
    // del mes natural (el resto del mes ya se pagó al precio viejo). Si baja o
    // no cambia, no se factura (el ahorro llega en la próxima recurrente).
    if (args.prorate && args.newPrice != null && existing.customerId) {
      const newPrice = args.newPrice;
      if (isGreaterThan(newPrice, oldPrice)) {
        const tz = await this.prisma.withTenant(
          (tx) =>
            tx.unit.findUnique({
              where: { id: args.newUnitId },
              select: { facility: { select: { timezone: true } } },
            }),
          args.tenantId,
        );
        // El día de hoy en la zona del local (en UTC, de 00:00 a 02:00 era ayer).
        const now = todayInTimezone(tz?.facility.timezone ?? 'Europe/Madrid');
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const remainingDays = daysInMonth - now.getUTCDate() + 1; // incluye hoy
        const diff = subtractAmounts(newPrice, oldPrice);
        const adjustment = Math.round((toCents(diff) * remainingDays) / daysInMonth) / 100;
        if (adjustment > 0) {
          try {
            const newUnitKind = await this.prisma.withTenant(
              (tx) =>
                tx.unit.findUnique({
                  where: { id: args.newUnitId },
                  select: { unitType: { select: { propertyKind: true } } },
                }),
              args.tenantId,
            );
            const draft = await this.invoices.create({
              tenantId: args.tenantId,
              userId: args.userId,
              meta: args.meta,
              input: {
                invoiceType: 'F1',
                customerId: existing.customerId,
                contractId: args.contractId,
                items: [
                  {
                    description: `Ajuste por cambio de trastero (${remainingDays} días)`,
                    quantity: 1,
                    unitPrice: adjustment,
                    ...rentTax(newUnitKind?.unitType.propertyKind),
                  },
                ],
                verifactuMode: 'verifactu',
              },
            });
            await this.invoices.issue({
              tenantId: args.tenantId,
              userId: args.userId,
              invoiceId: draft.id,
              meta: args.meta,
            });
          } catch (err) {
            // Best-effort: el traslado ya está hecho; si la factura falla (p. ej.
            // sin serie por defecto) queda registrado y no se bloquea el traslado.
            this.logger.warn(
              `changeUnit: no se pudo emitir la factura de ajuste del contrato ${args.contractId}: ${String(err)}`,
            );
          }
        }
      }
    }

    return this.toDto(updated);
  }

  /** Deja el traslado para su fecha, con el trastero de destino reservado. */
  private async scheduleMove(
    args: {
      tenantId: string;
      userId: string | null;
      contractId: string;
      newUnitId: string;
      newPrice?: number;
      prorate?: boolean;
      effectiveDate?: string;
      facilityScope?: string[] | null;
      meta: RequestMeta;
    },
    existing: { id: string; customerId: string; scheduledUnitId: string | null },
    date: Date,
  ): Promise<ContractDto> {
    if (existing.scheduledUnitId) {
      throw new ConflictException({
        code: 'move_already_scheduled',
        message: 'Este contrato ya tiene un traslado programado: anúlalo antes',
      });
    }
    await this.prisma.withTenant(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.tenantId}::text), hashtext(${args.newUnitId}::text))`;
      const unit = await tx.unit.findFirst({
        where: { id: args.newUnitId, facility: { deletedAt: null } },
      });
      if (!unit) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
      assertFacilityAllowed(args.facilityScope, unit.facilityId);
      if (unit.status !== 'available') {
        throw new BadRequestException({
          code: 'unit_not_available',
          message: 'El trastero de destino no está disponible',
        });
      }
      if (
        await unitHeldByOther(tx, {
          unitId: unit.id,
          contractId: existing.id,
          customerId: existing.customerId,
        })
      ) {
        throw new ConflictException({
          code: 'unit_reserved_for_other',
          message: 'El trastero de destino está reservado para otro inquilino',
        });
      }
      await this.syncUnitStatus(
        tx,
        args,
        unit.id,
        'available',
        'reserved',
        'Reservado para un traslado programado',
      );
      await tx.contract.update({
        where: { id: args.contractId },
        data: {
          scheduledUnitId: unit.id,
          scheduledUnitDate: date,
          scheduledUnitPrice: args.newPrice ?? null,
          scheduledUnitProrate: args.prorate ?? false,
        },
      });
      await tx.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: args.contractId,
          eventType: 'note_added',
          payload: {
            event: 'move_scheduled',
            toUnitCode: unit.code,
            date: args.effectiveDate ?? null,
          },
          createdByUserId: args.userId,
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.move_scheduled',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { toUnitId: args.newUnitId, date: args.effectiveDate ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.detail(args.tenantId, args.contractId, args.facilityScope);
  }

  /** Asigna o quita (planId null) el seguro de un contrato; congela la prima. */
  /**
   * Gating por plan: asignar un seguro requiere la feature `insurance`. Se
   * comprueba en el service (no en el controller) porque solo aplica al
   * ASIGNAR un plan, no al quitarlo — un tenant que perdió la feature
   * (downgrade) debe poder seguir retirando un seguro ya asignado.
   */
  private async assertInsuranceFeature(tenantId: string): Promise<void> {
    const sub = await this.prisma.withTenant(
      (tx) =>
        tx.tenantSubscription.findUnique({
          where: { tenantId },
          include: { plan: { select: { slug: true, tenantFeatures: true } } },
        }),
      tenantId,
    );
    if (!(sub ? resolvePlanFeatures(sub.plan) : []).includes('insurance')) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'El seguro de contenido no está incluido en tu plan',
        details: { requiredFeature: 'insurance' },
      });
    }
  }

  /** % de retención de IRPF del contrato: aplica a las facturas que se emitan desde ahora. */
  async setIrpfRetention(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    pct: number;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: { irpfRetentionPct: args.pct },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.irpf_retention_changed',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { from: Number(existing.irpfRetentionPct), to: args.pct },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.detail(args.tenantId, args.contractId, args.facilityScope);
  }

  async setInsurance(args: {
    tenantId: string;
    contractId: string;
    facilityScope?: string[] | null;
    planId: string | null;
  }): Promise<ContractDto> {
    await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    if (args.planId) await this.assertInsuranceFeature(args.tenantId);
    let insurancePlanId: string | null = null;
    let insurancePrice: number | null = null;
    if (args.planId) {
      const plan = await this.prisma.withTenant(
        (tx) =>
          tx.insurancePlan.findFirst({
            where: { id: args.planId!, tenantId: args.tenantId, isActive: true },
            select: { id: true, monthlyPrice: true },
          }),
        args.tenantId,
      );
      if (!plan) {
        throw new NotFoundException({
          code: 'insurance_plan_not_found',
          message: 'Plan de seguro no encontrado o inactivo',
        });
      }
      insurancePlanId = plan.id;
      insurancePrice = Number(plan.monthlyPrice);
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: { insurancePlanId, insurancePrice },
          include: {
            customer: {
              select: { firstName: true, lastName: true, companyName: true, customerType: true },
            },
            unit: {
              select: { code: true, facilityId: true, facility: { select: { name: true } } },
            },
            insurancePlan: { select: { name: true } },
            owner: { select: { legalName: true } },
            invoices: DEPOSIT_RECEIPT_SELECT,
            couponRedemptions: COUPON_SELECT,
          },
        }),
      args.tenantId,
    );
    return this.toDto(updated);
  }

  async addNote(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    facilityScope?: string[] | null;
    input: AddContractNoteInput;
    meta: RequestMeta;
  }): Promise<ContractEventDto> {
    await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.contractEvent.create({
          data: {
            tenantId: args.tenantId,
            contractId: args.contractId,
            eventType: 'note_added',
            payload: { note: args.input.note.trim() },
            createdByUserId: args.userId,
          },
          include: { createdBy: { select: { fullName: true } } },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.note_added',
      entityType: 'Contract',
      entityId: args.contractId,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return {
      id: row.id,
      eventType: row.eventType,
      payload: (row.payload as Record<string, unknown>) ?? {},
      createdByUserId: row.createdByUserId,
      createdByName: row.createdBy?.fullName ?? null,
      occurredAt: row.occurredAt.toISOString(),
    };
  }

  /**
   * Setea el `signed_pdf_url` y emite audit. Lo llama ContractPdfService
   * tras subir el PDF a MinIO.
   */
  async attachSignedPdf(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    facilityScope?: string[] | null;
    pdfUrl: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.contractId, args.facilityScope);
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: { signedPdfUrl: args.pdfUrl },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.pdf_generated',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { pdfUrl: args.pdfUrl },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /** Lo que se descuenta del alquiler por una señal ya cobrada (base sin IVA). */
  private async signalCredit(
    tx: Prisma.TransactionClient,
    invoiceId: string | null,
  ): Promise<{ amount: number; reason: string } | null> {
    if (!invoiceId) return null;
    const signal = await tx.invoice.findFirst({
      where: { id: invoiceId, status: 'paid' },
      select: { invoiceNumber: true, items: { select: { total: true, taxAmount: true } } },
    });
    if (!signal) return null;
    const baseCents = signal.items.reduce(
      (acc, it) => acc + toCents(Number(it.total) - Number(it.taxAmount)),
      0,
    );
    if (baseCents <= 0) return null;
    return { amount: baseCents / 100, reason: `señal ${signal.invoiceNumber}` };
  }

  private async findOrThrow(
    tenantId: string,
    contractId: string,
    facilityScope?: string[] | null,
  ): Promise<ContractWithRelations> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: { id: contractId, deletedAt: null },
          include: {
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
            unit: {
              select: {
                code: true,
                facilityId: true,
                facility: { select: { name: true } },
                unitType: { select: { propertyKind: true } },
              },
            },
            insurancePlan: { select: { name: true } },
            owner: { select: { legalName: true } },
            invoices: DEPOSIT_RECEIPT_SELECT,
            couponRedemptions: COUPON_SELECT,
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    assertFacilityAllowed(facilityScope, row.unit.facilityId);
    return row;
  }

  private assertTransition(from: ContractStatus, to: ContractStatusValue): void {
    const allowed = ALLOWED_TRANSITIONS[from as ContractStatusValue];
    if (!allowed.includes(to)) {
      throw new BadRequestException({
        code: 'invalid_contract_transition',
        message: `Transicion invalida: ${from} -> ${to}`,
      });
    }
  }

  /**
   * Sincroniza el `units.status` cuando un contrato cambia de estado.
   * Actualiza el unit directamente y graba `unit_status_history`. Bypasea
   * la regla "occupied solo via contract" del UnitsService porque ESTE
   * es el flujo de contrato.
   */
  /**
   * El trastero de un contrato que se cierra vuelve a la venta, salvo que el
   * contrato tenga un expediente de impago abierto: los bienes siguen dentro y
   * queda bloqueado hasta que se vacíe. Devuelve si quedó disponible.
   */
  private async releaseOrHoldUnit(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; userId: string | null; meta: RequestMeta },
    unitId: string,
    contractId: string,
    from: UnitStatus,
    reason: string,
  ): Promise<boolean> {
    const withCase = await tx.delinquencyCase.count({
      where: {
        contractId,
        status: { notIn: ['closed_paid', 'closed_disposed', 'closed_cancelled'] },
      },
    });
    if (withCase === 0) {
      await this.syncUnitStatus(tx, ctx, unitId, from, 'available', reason);
      return true;
    }
    await this.syncUnitStatus(
      tx,
      ctx,
      unitId,
      from,
      'blocked',
      `${reason} con un impago abierto: bienes retenidos`,
    );
    await tx.unit.update({
      where: { id: unitId },
      data: {
        outOfServiceReason: 'Impago: bienes retenidos hasta vaciarlo',
        outOfServiceSince: new Date(),
      },
    });
    return false;
  }

  private async syncUnitStatus(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; userId: string | null; meta: RequestMeta },
    unitId: string,
    from: UnitStatus,
    to: UnitStatus,
    reason: string,
  ): Promise<void> {
    if (from === to) return;
    await tx.unit.update({
      where: { id: unitId },
      data: { status: to },
    });
    await tx.unitStatusHistory.create({
      data: {
        tenantId: ctx.tenantId,
        unitId,
        previousStatus: from,
        newStatus: to,
        changedByUserId: ctx.userId,
        reason,
      },
    });
  }

  private async nextContractNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    // Dos altas a la vez leerían el mismo último número.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('contract-number'))`;
    // Patron simple: prefijo CT- + zero-padded count + año. Para Fase 4
    // (Verifactu) habra invoice_series por tenant; aqui no.
    const year = new Date().getFullYear();
    const prefix = `CT-${year}-`;
    const last = await tx.contract.findFirst({
      where: { tenantId, contractNumber: { startsWith: prefix } },
      orderBy: { contractNumber: 'desc' },
      select: { contractNumber: true },
    });
    let next = 1;
    if (last) {
      const tail = last.contractNumber.slice(prefix.length);
      const n = Number.parseInt(tail, 10);
      if (Number.isFinite(n)) next = n + 1;
    }
    return `${prefix}${String(next).padStart(5, '0')}`;
  }

  private toDto(row: ContractWithRelations): ContractDto {
    const customerName =
      row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre';
    const base = Number(row.priceMonthly);
    const discount = Number(row.discountAmount);
    return {
      id: row.id,
      contractNumber: row.contractNumber,
      customerId: row.customerId,
      customerName,
      unitId: row.unitId,
      unitCode: row.unit.code,
      facilityId: row.unit.facilityId,
      facilityName: row.unit.facility.name,
      status: row.status as ContractStatusValue,
      startDate: row.startDate.toISOString().slice(0, 10),
      endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
      signedAt: row.signedAt ? row.signedAt.toISOString() : null,
      endingRequestedAt: row.endingRequestedAt ? row.endingRequestedAt.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      billingCycle: row.billingCycle,
      billingIntervalMonths: row.billingIntervalMonths,
      billingStartsOn: row.billingStartsOn ? row.billingStartsOn.toISOString().slice(0, 10) : null,
      irpfRetentionPct: Number(row.irpfRetentionPct),
      ownerId: row.ownerId,
      ownerName: row.owner?.legalName ?? null,
      prepayDiscountPct: Number(row.prepayDiscountPct),
      firstPaymentMonths: row.firstPaymentMonths,
      coupon: row.couponRedemptions?.[0]
        ? {
            code: row.couponRedemptions[0].coupon.code,
            months: row.couponRedemptions[0].months,
            discountAmount: Number(row.couponRedemptions[0].discountAmount),
            freeMonths: row.couponRedemptions[0].freeMonths,
          }
        : null,
      priceMonthly: base,
      discountAmount: discount,
      discountReason: row.discountReason,
      discountExpiresAt: row.discountExpiresAt ? row.discountExpiresAt.toISOString() : null,
      effectivePrice: this.pricing.computeEffectivePrice({ base, discount }),
      freeMonthsRemaining: row.freeMonthsRemaining,
      depositAmount: Number(row.depositAmount),
      depositStatus: row.depositStatus,
      depositReturnedAmount: Number(row.depositReturnedAmount),
      depositSettledAt: row.depositSettledAt ? row.depositSettledAt.toISOString() : null,
      depositRetentionReason: row.depositRetentionReason,
      propertyKind: row.unit.unitType?.propertyKind === 'housing' ? 'housing' : 'storage',
      depositRegistry: {
        body: row.depositRegistryBody,
        registeredAt: row.depositRegisteredAt
          ? row.depositRegisteredAt.toISOString().slice(0, 10)
          : null,
        reference: row.depositRegistryReference,
        hasReceipt: !!row.depositRegistryReceiptKey,
        recoveredAt: row.depositRegistryRecoveredAt
          ? row.depositRegistryRecoveredAt.toISOString().slice(0, 10)
          : null,
      },
      depositPaymentMethod: row.depositPaymentMethod === 'cash' ? 'cash' : 'online',
      depositCollected: row.invoices?.[0]?.status === 'paid',
      depositAppliedAmount: Number(row.depositAppliedAmount),
      creditBalance: Number(row.creditBalance),
      depositReturnMethod: row.depositReturnMethod,
      depositReturnedOn: row.depositReturnedOn?.toISOString().slice(0, 10) ?? null,
      depositReturnReference: row.depositReturnReference,
      scheduledPrice:
        row.scheduledPrice != null && row.scheduledPriceDate
          ? {
              amount: Number(row.scheduledPrice),
              date: row.scheduledPriceDate.toISOString().slice(0, 10),
              reason: row.scheduledPriceReason,
            }
          : null,
      scheduledMove:
        row.scheduledUnitId && row.scheduledUnitDate
          ? {
              unitId: row.scheduledUnitId,
              unitCode: null,
              date: row.scheduledUnitDate.toISOString().slice(0, 10),
              price: row.scheduledUnitPrice != null ? Number(row.scheduledUnitPrice) : null,
            }
          : null,
      depositReceipt: row.invoices?.[0]
        ? {
            id: row.invoices[0].id,
            number: row.invoices[0].invoiceNumber,
            status: row.invoices[0].status,
          }
        : null,
      hasSignedPdf: !!row.signedPdfUrl,
      insurancePlanId: row.insurancePlanId,
      insurancePlanName: row.insurancePlan?.name ?? null,
      insurancePrice: row.insurancePrice != null ? Number(row.insurancePrice) : null,
      autoRenew: row.autoRenew,
      cancellationNoticeDays: row.cancellationNoticeDays,
      moveOutEndOfMonth: row.moveOutEndOfMonth === true,
      withdrawalDeadline: row.withdrawalDeadline?.toISOString().slice(0, 10) ?? null,
      immediateStartRequestedAt: row.immediateStartRequestedAt?.toISOString() ?? null,
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      notes: row.notes,
      preOpening: preOpeningDto(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
