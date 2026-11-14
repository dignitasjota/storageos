import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { pendingPriceChanges, type PendingPriceChange } from '../../common/price-changes';
import { resolveAnalyticsScope } from '../analytics/analytics-scope';
import { InsightsService } from '../analytics/insights.service';
import { AuditService } from '../auth/audit.service';
import { AnniversaryUpdatesService } from '../contracts/anniversary-updates.service';
import { overdueInvoiceWhere } from '../dashboard/today-filters';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { ContractAnnexesService } from '../move-in/contract-annexes.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractAnnexSentDto,
  PriceChangeRowDto,
  PriceHistoryDto,
  PriceHistoryEntryDto,
  RenewalAnnexAction,
  RenewalOfferInput,
  RenewalRowDto,
  RenewalWindow,
  SetAnniversaryPctInput,
  SetRentIncreaseExemptionInput,
} from '@storageos/shared';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  return c.customerType === 'business'
    ? (c.companyName ?? 'Empresa')
    : [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Inquilino';
}

function addMonths(d: Date, months: number): Date {
  const day = d.getUTCDate();
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** Meses completos entre dos fechas. */
function monthsBetween(from: Date, to: Date): number {
  const m =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) -
    (to.getUTCDate() < from.getUTCDate() ? 1 : 0);
  return Math.max(0, m);
}

/**
 * Cartera: los cambios de cuota previstos de todos los contratos, el
 * historial de la cuota de uno, la bandeja de renovaciones (con deuda y
 * riesgo de baja) y la oferta de renovación que el inquilino firma como anexo.
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly insights: InsightsService,
    private readonly anniversary: AnniversaryUpdatesService,
    private readonly annexes: ContractAnnexesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------- cuotas previstas

  /**
   * Todos los cambios de cuota previstos: los programados en la ficha, las
   * subidas de una tanda y las actualizaciones anuales por revisar. Solo los
   * que se aplicarán de verdad (una subida cuya cuota avisada ya no coincide
   * la salta el proceso diario).
   */
  async priceChanges(
    tenantId: string,
    filters: { facilityId?: string; facilityScope?: string[] | null },
  ): Promise<PriceChangeRowDto[]> {
    const ids = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (ids === null) return [];
    const pending = await pendingPriceChanges(this.admin, tenantId);
    const contractIds = [...pending.keys()];
    const contracts = contractIds.length
      ? await this.prisma.withTenant(
          (tx) =>
            tx.contract.findMany({
              where: {
                id: { in: contractIds },
                ...(ids ? { unit: { facilityId: { in: ids } } } : {}),
              },
              select: {
                id: true,
                contractNumber: true,
                customerId: true,
                priceMonthly: true,
                scheduledPriceDate: true,
                customer: {
                  select: {
                    customerType: true,
                    firstName: true,
                    lastName: true,
                    companyName: true,
                  },
                },
                unit: { select: { code: true, facility: { select: { name: true } } } },
              },
            }),
          tenantId,
        )
      : [];
    const items = contractIds.length
      ? await this.admin.rentIncreaseItem.findMany({
          where: { tenantId, contractId: { in: contractIds }, status: 'pending' },
          select: { id: true, contractId: true, rentIncreaseId: true, noticeStatus: true },
        })
      : [];
    const itemOf = new Map(items.map((i) => [`${i.contractId}:${i.rentIncreaseId}`, i]));
    const rows: PriceChangeRowDto[] = [];
    for (const c of contracts) {
      let running = Number(c.priceMonthly);
      for (const ch of pending.get(c.id) ?? []) {
        if (ch.source === 'rent_increase' && !sameAmount(ch.oldPrice ?? -1, running)) continue;
        const item =
          ch.source === 'rent_increase' ? itemOf.get(`${c.id}:${ch.rentIncreaseId}`) : undefined;
        rows.push(
          this.priceChangeRow(c, running, ch, {
            itemId: item?.id ?? null,
            notified: ch.source === 'scheduled' ? true : item?.noticeStatus === 'sent',
          }),
        );
        running = ch.price;
      }
    }
    // Actualizaciones anuales por revisar (aún no son un cambio, solo propuesta).
    const settings = await this.anniversary.getSettings(tenantId);
    if (settings.enabled) {
      const scope = ids ?? filters.facilityScope ?? null;
      const due = await this.anniversary.listDue(tenantId, scope);
      const meta = due.length
        ? await this.prisma.withTenant(
            (tx) =>
              tx.contract.findMany({
                where: { id: { in: due.map((d) => d.contractId) } },
                select: { id: true, unit: { select: { facility: { select: { name: true } } } } },
              }),
            tenantId,
          )
        : [];
      const facilityOf = new Map(meta.map((m) => [m.id, m.unit.facility.name]));
      for (const d of due) {
        if (d.newPrice === d.currentPrice) continue;
        rows.push({
          contractId: d.contractId,
          contractNumber: d.contractNumber,
          customerId: d.customerId,
          customerName: d.customerName,
          unitCode: d.unitCode,
          facilityName: facilityOf.get(d.contractId) ?? '',
          currentPrice: d.currentPrice,
          newPrice: d.newPrice,
          date: d.anniversary,
          source: 'anniversary',
          rentIncreaseId: null,
          rentIncreaseName: null,
          rentIncreaseItemId: null,
          notified: false,
        });
      }
    }
    return rows.sort(
      (a, b) => a.date.localeCompare(b.date) || a.contractNumber.localeCompare(b.contractNumber),
    );
  }

  private priceChangeRow(
    c: {
      id: string;
      contractNumber: string;
      customerId: string;
      customer: Parameters<typeof customerName>[0];
      unit: { code: string; facility: { name: string } };
    },
    current: number,
    ch: PendingPriceChange,
    extra: { itemId: string | null; notified: boolean },
  ): PriceChangeRowDto {
    return {
      contractId: c.id,
      contractNumber: c.contractNumber,
      customerId: c.customerId,
      customerName: customerName(c.customer),
      unitCode: c.unit.code,
      facilityName: c.unit.facility.name,
      currentPrice: current,
      newPrice: ch.price,
      date: iso(ch.date),
      source: ch.source,
      rentIncreaseId: ch.rentIncreaseId,
      rentIncreaseName: ch.rentIncreaseName,
      rentIncreaseItemId: extra.itemId,
      notified: extra.notified,
    };
  }

  // ------------------------------------------------- historial de la cuota

  async priceHistory(
    tenantId: string,
    contractId: string,
    facilityScope: string[] | null,
  ): Promise<PriceHistoryDto> {
    const contract = await this.loadContract(tenantId, contractId, facilityScope);
    const events = await this.prisma.withTenant(
      (tx) =>
        tx.contractEvent.findMany({
          where: { contractId, eventType: 'price_changed' },
          orderBy: { occurredAt: 'asc' },
          select: { payload: true, occurredAt: true },
        }),
      tenantId,
    );
    const changes = events
      .map((e) => {
        const p = (e.payload ?? {}) as { from?: unknown; to?: unknown; reason?: unknown };
        const from = Number(p.from);
        const to = Number(p.to);
        return Number.isFinite(to)
          ? {
              at: e.occurredAt,
              from: Number.isFinite(from) ? from : null,
              to,
              reason: typeof p.reason === 'string' ? readableReason(p.reason) : null,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const entries: PriceHistoryEntryDto[] = [];
    const first = changes[0];
    entries.push({
      date: iso(contract.startDate),
      from: null,
      to: first?.from ?? Number(contract.priceMonthly),
      reason: 'Alta del contrato',
      kind: 'start',
    });
    for (const c of changes) {
      entries.push({ date: iso(c.at), from: c.from, to: c.to, reason: c.reason, kind: 'change' });
    }
    const pending = (await pendingPriceChanges(this.admin, tenantId, { contractIds: [contractId] }))
      .get(contractId)
      ?.slice();
    let running = Number(contract.priceMonthly);
    for (const ch of pending ?? []) {
      if (ch.source === 'rent_increase' && !sameAmount(ch.oldPrice ?? -1, running)) continue;
      entries.push({
        date: iso(ch.date),
        from: running,
        to: ch.price,
        reason:
          ch.source === 'rent_increase'
            ? `Subida «${ch.rentIncreaseName ?? ''}»`
            : (contract.scheduledPriceReason ?? 'Cambio programado'),
        kind: 'scheduled',
      });
      running = ch.price;
    }
    return { entries };
  }

  // --------------------------------------------------- bandeja de renovación

  async renewals(
    tenantId: string,
    filters: { window: RenewalWindow; facilityId?: string; facilityScope?: string[] | null },
  ): Promise<RenewalRowDto[]> {
    const ids = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (ids === null) return [];
    const today = todayInTimezone();
    const endDate =
      filters.window === 'overdue'
        ? { not: null, lt: today }
        : { not: null, lte: new Date(today.getTime() + Number(filters.window) * DAY) };
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            deletedAt: null,
            status: { in: ['active', 'ending'] },
            endDate,
            ...(ids ? { unit: { facilityId: { in: ids } } } : {}),
          },
          orderBy: [{ endDate: 'asc' }, { contractNumber: 'asc' }],
          select: {
            id: true,
            contractNumber: true,
            customerId: true,
            status: true,
            autoRenew: true,
            endDate: true,
            startDate: true,
            priceMonthly: true,
            discountAmount: true,
            customer: {
              select: {
                customerType: true,
                firstName: true,
                lastName: true,
                companyName: true,
                phone: true,
                email: true,
              },
            },
            unit: { select: { code: true, facility: { select: { name: true } } } },
          },
        }),
      tenantId,
    );
    if (contracts.length === 0) return [];
    const contractIds = contracts.map((c) => c.id);
    const [debts, offers, risk] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.invoice.groupBy({
            by: ['contractId'],
            where: { ...overdueInvoiceWhere(today), contractId: { in: contractIds } },
            _sum: { total: true, amountPaid: true },
          }),
        tenantId,
      ),
      this.admin.contractAnnex.findMany({
        where: { tenantId, contractId: { in: contractIds }, status: 'pending' },
        select: { id: true, contractId: true, action: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.insights.getChurnRisk(
        tenantId,
        resolveAnalyticsScope(filters.facilityScope ?? null, filters.facilityId),
      ),
    ]);
    const debtOf = new Map(
      debts.map((d) => [
        d.contractId,
        round2(Math.max(0, Number(d._sum.total ?? 0) - Number(d._sum.amountPaid ?? 0))),
      ]),
    );
    const offerOf = new Map<string, RenewalRowDto['pendingOffer']>();
    for (const o of offers) {
      const a = o.action as Partial<RenewalAnnexAction> | null;
      if (a?.type !== 'renewal' || offerOf.has(o.contractId)) continue;
      offerOf.set(o.contractId, {
        annexId: o.id,
        months: Number(a.months),
        newPrice: a.newPrice != null ? Number(a.newPrice) : null,
        sentAt: o.createdAt.toISOString(),
      });
    }
    const riskOf = new Map(risk.items.map((r) => [r.contractId, r]));
    return contracts.map((c) => {
      const r = riskOf.get(c.id);
      return {
        contractId: c.id,
        contractNumber: c.contractNumber,
        customerId: c.customerId,
        customerName: customerName(c.customer),
        customerPhone: c.customer.phone,
        customerEmail: c.customer.email,
        unitCode: c.unit.code,
        facilityName: c.unit.facility.name,
        status: c.status === 'ending' ? 'ending' : 'active',
        autoRenew: c.autoRenew,
        endDate: iso(c.endDate!),
        priceMonthly: Number(c.priceMonthly),
        discountAmount: Number(c.discountAmount),
        monthsAsCustomer: monthsBetween(c.startDate, today),
        debt: debtOf.get(c.id) ?? 0,
        risk: r?.level ?? 'low',
        riskFactors: r?.factors ?? [],
        pendingOffer: offerOf.get(c.id) ?? null,
      };
    });
  }

  // ----------------------------------------------------- oferta de renovación

  /**
   * Envía al inquilino una oferta de renovación como anexo del contrato. Al
   * firmarla desde el enlace o su área de clientes, el contrato se renueva
   * solo con lo ofrecido (si no ha cambiado entretanto).
   */
  async sendRenewalOffer(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: RenewalOfferInput;
    facilityScope: string[] | null;
    meta: RequestMeta;
  }): Promise<ContractAnnexSentDto> {
    const c = await this.loadContract(args.tenantId, args.contractId, args.facilityScope);
    if (c.status !== 'active' && c.status !== 'ending') {
      throw new BadRequestException({
        code: 'contract_not_renewable',
        message: 'Solo se pueden renovar contratos activos o en baja',
      });
    }
    if (!c.endDate) {
      throw new BadRequestException({
        code: 'contract_indefinite',
        message: 'Este contrato no tiene fecha de fin: sigue en vigor sin renovarlo',
      });
    }
    const newPrice =
      args.input.newPrice != null && args.input.newPrice !== Number(c.priceMonthly)
        ? round2(args.input.newPrice)
        : null;
    if (newPrice !== null) {
      if (Number(c.discountAmount) > newPrice) {
        throw new BadRequestException({
          code: 'discount_too_high',
          message: 'La cuota no puede ser menor que el descuento del contrato',
        });
      }
      const pending = await pendingPriceChanges(this.admin, args.tenantId, {
        contractIds: [args.contractId],
      });
      if ((pending.get(args.contractId) ?? []).length > 0) {
        throw new ConflictException({
          code: 'price_change_pending',
          message:
            'Ya tiene un cambio de cuota programado: ofrécele la renovación sin cambiar la cuota o anula el cambio antes',
        });
      }
    }
    const open = await this.admin.contractAnnex.findMany({
      where: { tenantId: args.tenantId, contractId: args.contractId, status: 'pending' },
      select: { action: true },
    });
    if (open.some((o) => (o.action as { type?: string } | null)?.type === 'renewal')) {
      throw new ConflictException({
        code: 'renewal_offer_pending',
        message:
          'Ya tiene una oferta de renovación sin firmar: reenvíala o anúlala en la pestaña Firma',
      });
    }
    const today = todayInTimezone();
    const base = c.endDate.getTime() >= today.getTime() ? c.endDate : today;
    const from = new Date(base.getTime() + DAY);
    const until = addMonths(base, args.input.months);
    const months = args.input.months;
    const paragraphs = [
      `Las partes acuerdan prorrogar el contrato ${c.contractNumber} ${months} ${months === 1 ? 'mes' : 'meses'} más, desde el ${formatDateLong(from)} hasta el ${formatDateLong(until)}.`,
      newPrice !== null
        ? `Desde el ${formatDateLong(from)}, la cuota mensual del trastero será de ${formatEur(newPrice)} más IVA.`
        : 'La cuota mensual no cambia.',
      'El resto de condiciones del contrato siguen igual.',
      args.input.note?.trim() ?? '',
    ].filter(Boolean);
    const action: RenewalAnnexAction = {
      type: 'renewal',
      months,
      newPrice,
      expectedEndDate: iso(c.endDate),
    };
    const sent = await this.annexes.create({
      tenantId: args.tenantId,
      userId: args.userId,
      contractId: args.contractId,
      input: { title: 'Renovación del contrato', body: paragraphs.join('\n\n') },
      scope: args.facilityScope,
      meta: args.meta,
      action,
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.renewal_offer_sent',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { months, newPrice },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return sent;
  }

  // ------------------------------------------------ excepciones y % anual

  async setExemption(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: SetRentIncreaseExemptionInput;
    facilityScope: string[] | null;
  }): Promise<void> {
    await this.loadContract(args.tenantId, args.contractId, args.facilityScope);
    const until = args.input.until ? new Date(`${args.input.until}T00:00:00.000Z`) : null;
    if (until && until.getTime() < todayInTimezone().getTime()) {
      throw new BadRequestException({
        code: 'invalid_until',
        message: 'La fecha tiene que ser de hoy en adelante',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: {
            rentIncreaseExemptUntil: until,
            rentIncreaseExemptReason: until ? args.input.reason?.trim() || null : null,
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.rent_increase_exemption_changed',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { until: args.input.until, reason: args.input.reason ?? null },
    });
  }

  async setAnniversaryPct(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: SetAnniversaryPctInput;
    facilityScope: string[] | null;
  }): Promise<void> {
    await this.loadContract(args.tenantId, args.contractId, args.facilityScope);
    await this.prisma.withTenant(
      (tx) =>
        tx.contract.update({
          where: { id: args.contractId },
          data: { anniversaryUpdatePct: args.input.pct },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.anniversary_pct_changed',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: { pct: args.input.pct },
    });
  }

  private async loadContract(tenantId: string, contractId: string, scope: string[] | null) {
    const c = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: { id: contractId, deletedAt: null },
          select: {
            id: true,
            contractNumber: true,
            status: true,
            startDate: true,
            endDate: true,
            priceMonthly: true,
            discountAmount: true,
            scheduledPriceReason: true,
            unit: { select: { facilityId: true } },
          },
        }),
      tenantId,
    );
    if (!c) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    assertFacilityAllowed(scope, c.unit.facilityId);
    return c;
  }
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** El motivo guardado en el evento, en palabras (las subidas llevan su id). */
function readableReason(reason: string): string {
  if (reason.startsWith('rent_increase:')) return 'Subida de precio';
  return reason;
}
