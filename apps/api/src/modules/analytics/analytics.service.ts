import { Injectable } from '@nestjs/common';
import {
  effectiveFeaturesFromList,
  resolvePlanFeatures,
  NON_CASH_PAYMENT_METHODS,
} from '@storageos/shared';

import { liveOverrideWhere } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import {
  ALL_FACILITIES,
  contractLifecycle,
  contractWhere,
  invalidDate,
  invoiceWhere,
  leadWhere,
  LIFECYCLE_SELECT,
  liveMrr,
  unitWhere,
  type AnalyticsScope,
} from './analytics-scope';

import type { Prisma } from '@storageos/database';
import type {
  AgingKpiDto,
  ChurnKpiDto,
  CustomerStatsKpiDto,
  LeadsFunnelKpiDto,
  LeadsUtmKpiDto,
  MonthlyRevenueKpiDto,
  OccupancyKpiDto,
  RevenueKpiDto,
  SeoChecklistDto,
  SeoChecklistItemDto,
  TenantFeature,
  WebPerformanceDto,
} from '@storageos/shared';

type AgingBucketRange = '0-30' | '30-60' | '60-90' | '+90';

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value);
}

function parseYearMonth(yearMonth: string, field = 'mes'): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  const year = match ? Number(match[1]) : NaN;
  const month = match ? Number(match[2]) : NaN;
  if (!match || month < 1 || month > 12 || year < 2000 || year > 2100) {
    throw invalidDate(field, yearMonth);
  }
  return { year, month };
}

function formatYearMonth(year: number, month: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
}

function monthStartUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}

/** Parsea un "YYYY-MM" a índice absoluto de mes (year*12 + month-1). null si inválido. */
function parseYearMonthIdx(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return year * 12 + (month - 1);
}

const MONTH_RANGE_MAX = 36;

/**
 * Lista de meses (más antiguo → actual) a partir de un rango `from`/`to`
 * ("YYYY-MM") o, si no hay rango válido, los últimos `months` meses hasta hoy.
 * Acota a `MONTH_RANGE_MAX` meses por seguridad.
 */
function resolveMonthList(opts: {
  months?: number;
  from?: string;
  to?: string;
}): { year: number; month: number; key: string }[] {
  const now = new Date();
  const curIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();

  let startIdx: number;
  let endIdx: number;
  const fromIdx = parseYearMonthIdx(opts.from);
  const toIdx = parseYearMonthIdx(opts.to);
  if (fromIdx !== null && toIdx !== null) {
    startIdx = Math.min(fromIdx, toIdx);
    endIdx = Math.max(fromIdx, toIdx);
    // No proyectar al futuro: el tope es el mes actual.
    if (endIdx > curIdx) endIdx = curIdx;
    if (startIdx > endIdx) startIdx = endIdx;
    if (endIdx - startIdx + 1 > MONTH_RANGE_MAX) startIdx = endIdx - (MONTH_RANGE_MAX - 1);
  } else {
    const span = Math.min(MONTH_RANGE_MAX, Math.max(1, Math.trunc(opts.months ?? 12) || 12));
    endIdx = curIdx;
    startIdx = curIdx - (span - 1);
  }

  const list: { year: number; month: number; key: string }[] = [];
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    list.push({ year, month, key: formatYearMonth(year, month) });
  }
  return list;
}

function nextMonthStartUtc(year: number, month: number): Date {
  return month === 12 ? monthStartUtc(year + 1, 1) : monthStartUtc(year, month + 1);
}

function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseDate(value: string, field = 'fecha'): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw invalidDate(field, value);
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(match[3])) {
    throw invalidDate(field, value);
  }
  return d;
}

function bucketForDaysOverdue(days: number): AgingBucketRange {
  if (days < 30) return '0-30';
  if (days < 60) return '30-60';
  if (days < 90) return '60-90';
  return '+90';
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  // ---------------------------------------------------------------------------
  // 1. Ocupacion
  // ---------------------------------------------------------------------------
  async getOccupancy(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<OccupancyKpiDto> {
    const units = unitWhere(scope);
    const facilityIdWhere = scope.ids ? { id: { in: scope.ids } } : {};

    return this.prisma.withTenant(async (tx) => {
      const [byStatus, potential, live, facilities, facilityCounts] = await Promise.all([
        tx.unit.groupBy({ by: ['status'], where: units, _count: { _all: true } }),
        // Lo que se ingresaría con todo alquilado: el precio de cada trastero que
        // se puede alquilar (los que están en mantenimiento o bloqueados no).
        tx.unit.aggregate({
          where: { ...units, status: { in: ['available', 'reserved', 'occupied'] } },
          _sum: { basePriceMonthly: true },
        }),
        liveMrr(tx, scope),
        tx.facility.findMany({
          where: { deletedAt: null, ...facilityIdWhere },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        tx.unit.groupBy({ by: ['facilityId', 'status'], where: units, _count: { _all: true } }),
      ]);

      let totalUnits = 0;
      let occupiedUnits = 0;
      let reservedUnits = 0;
      let availableUnits = 0;
      for (const row of byStatus) {
        const count = row._count._all;
        totalUnits += count;
        if (row.status === 'occupied') occupiedUnits += count;
        else if (row.status === 'reserved') reservedUnits += count;
        else if (row.status === 'available') availableUnits += count;
      }
      const outOfServiceUnits = totalUnits - occupiedUnits - reservedUnits - availableUnits;
      const physicalOccupancy = totalUnits === 0 ? 0 : occupiedUnits / totalUnits;
      const mrrActual = live.mrr;
      const mrrPotential = Math.round(toNumber(potential._sum.basePriceMonthly) * 100) / 100;
      const economicOccupancy = mrrPotential === 0 ? 0 : Math.min(1, mrrActual / mrrPotential);

      const perFacility = facilities.map((f) => {
        const rows = facilityCounts.filter((r) => r.facilityId === f.id);
        const of = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
        const total = rows.reduce((sum, r) => sum + r._count._all, 0);
        const occupied = of('occupied');
        const reserved = of('reserved');
        const available = of('available');
        return {
          facilityId: f.id,
          facilityName: f.name,
          total,
          occupied,
          reserved,
          available,
          outOfService: total - occupied - reserved - available,
        };
      });

      return {
        totalUnits,
        occupiedUnits,
        reservedUnits,
        availableUnits,
        outOfServiceUnits,
        physicalOccupancy,
        economicOccupancy,
        mrrActual,
        mrrPotential,
        perFacility,
      };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 2. Churn
  // ---------------------------------------------------------------------------
  async getChurn(
    tenantId: string,
    filters?: { from?: string; to?: string },
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<ChurnKpiDto> {
    const now = new Date();
    const curIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
    let startIdx: number;
    let endIdx: number;
    if (filters?.from && filters?.to) {
      const from = parseYearMonth(filters.from, 'from');
      const to = parseYearMonth(filters.to, 'to');
      startIdx = Math.min(from.year * 12 + from.month - 1, to.year * 12 + to.month - 1);
      endIdx = Math.min(
        curIdx,
        Math.max(from.year * 12 + from.month - 1, to.year * 12 + to.month - 1),
      );
      if (startIdx > endIdx) startIdx = endIdx;
      if (endIdx - startIdx + 1 > MONTH_RANGE_MAX) startIdx = endIdx - (MONTH_RANGE_MAX - 1);
    } else {
      // Por defecto, los últimos 12 meses incluido el actual.
      endIdx = curIdx;
      startIdx = curIdx - 11;
    }

    // Una sola lectura de los contratos firmados; el cálculo por mes va en memoria.
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: { signedAt: { not: null }, deletedAt: null, ...contractWhere(scope) },
          select: LIFECYCLE_SELECT,
        }),
      tenantId,
    );
    const lives = contracts
      .map((c) => contractLifecycle(c))
      .filter((l): l is NonNullable<typeof l> => l !== null);

    const months: ChurnKpiDto['months'] = [];
    for (let idx = startIdx; idx <= endIdx; idx++) {
      const year = Math.floor(idx / 12);
      const month = (idx % 12) + 1;
      const start = monthStartUtc(year, month).getTime();
      const end = nextMonthStartUtc(year, month).getTime();
      let activeAtStart = 0;
      let ended = 0;
      for (const l of lives) {
        const b = l.begin.getTime();
        const e = l.end?.getTime() ?? null;
        if (b < start && (e === null || e >= start)) activeAtStart += 1;
        // Solo cuenta la baja de quien estaba al empezar el mes (si no, la tasa pasa de 100 %).
        if (b < start && e !== null && e >= start && e < end) ended += 1;
      }
      months.push({
        yearMonth: formatYearMonth(year, month),
        activeAtStart,
        ended,
        churnRate: activeAtStart === 0 ? 0 : ended / activeAtStart,
      });
    }
    return { months };
  }

  // ---------------------------------------------------------------------------
  // 3. Aging de facturas pendientes
  // ---------------------------------------------------------------------------
  async getAging(
    tenantId: string,
    atDate?: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<AgingKpiDto> {
    const at = atDate ? parseDate(atDate, 'atDate') : startOfDayUtc(new Date());

    return this.prisma.withTenant(async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: {
          status: { in: ['issued', 'overdue', 'partially_refunded'] },
          deletedAt: null,
          // La fianza no es deuda del alquiler: se cobra y devuelve aparte.
          kind: 'invoice',
          dueDate: { lt: at },
          ...invoiceWhere(scope),
        },
        select: { dueDate: true, total: true, amountPaid: true },
      });

      const buckets: Record<AgingBucketRange, { amount: number; invoiceCount: number }> = {
        '0-30': { amount: 0, invoiceCount: 0 },
        '30-60': { amount: 0, invoiceCount: 0 },
        '60-90': { amount: 0, invoiceCount: 0 },
        '+90': { amount: 0, invoiceCount: 0 },
      };

      let totalOutstanding = 0;
      for (const inv of invoices) {
        if (!inv.dueDate) continue;
        const pending = toNumber(inv.total) - toNumber(inv.amountPaid);
        if (pending <= 0) continue;
        const daysOverdue = Math.floor(
          (at.getTime() - inv.dueDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (daysOverdue < 0) continue;
        const bucket = bucketForDaysOverdue(daysOverdue);
        buckets[bucket].amount += pending;
        buckets[bucket].invoiceCount += 1;
        totalOutstanding += pending;
      }

      const order: AgingBucketRange[] = ['0-30', '30-60', '60-90', '+90'];
      return {
        buckets: order.map((range) => ({
          range,
          amount: Math.round(buckets[range].amount * 100) / 100,
          invoiceCount: buckets[range].invoiceCount,
        })),
        totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 4. Funnel de leads
  // ---------------------------------------------------------------------------
  async getLeadsFunnel(
    tenantId: string,
    filters?: { from?: string; to?: string },
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<LeadsFunnelKpiDto> {
    const now = new Date();
    const defaultTo = startOfDayUtc(now);
    const defaultFrom = new Date(defaultTo.getTime() - 30 * 24 * 60 * 60 * 1000);

    const fromDate = filters?.from ? parseDate(filters.from, 'from') : defaultFrom;
    // Para incluir el dia "to" entero, sumamos 1 dia y usamos lt.
    const toDay = filters?.to ? parseDate(filters.to, 'to') : defaultTo;
    const toExclusive = new Date(toDay.getTime() + 24 * 60 * 60 * 1000);

    const rangeWhere: Prisma.LeadWhereInput = {
      deletedAt: null,
      createdAt: { gte: fromDate, lt: toExclusive },
      ...leadWhere(scope),
    };

    return this.prisma.withTenant(async (tx) => {
      const [byStatus, reachedContacted, reachedQualified, bySourceRows, lostReasonRows] =
        await Promise.all([
          tx.lead.groupBy({ by: ['status'], where: rangeWhere, _count: { _all: true } }),
          // Llegó a «contactado» aunque luego avanzara o se perdiera.
          tx.lead.count({
            where: {
              ...rangeWhere,
              AND: [
                {
                  OR: [
                    { contactedAt: { not: null } },
                    { status: { in: ['contacted', 'qualified', 'won'] } },
                  ],
                },
              ],
            },
          }),
          tx.lead.count({
            where: {
              ...rangeWhere,
              AND: [
                { OR: [{ qualifiedAt: { not: null } }, { status: { in: ['qualified', 'won'] } }] },
              ],
            },
          }),
          tx.lead.groupBy({ by: ['source'], where: rangeWhere, _count: { _all: true } }),
          tx.lead.groupBy({
            by: ['lostReasonCode'],
            where: { ...rangeWhere, status: 'lost' },
            _count: { _all: true },
          }),
        ]);

      const of = (status: string) => byStatus.find((r) => r.status === status)?._count._all ?? 0;
      const totals = {
        new: of('new'),
        contacted: of('contacted'),
        qualified: of('qualified'),
        won: of('won'),
        lost: of('lost'),
      };
      const total = byStatus.reduce((sum, r) => sum + r._count._all, 0);
      const reached = {
        contacted: reachedContacted,
        qualified: reachedQualified,
        won: totals.won,
      };

      return {
        totals,
        reached,
        total,
        from: fromDate.toISOString().slice(0, 10),
        to: toDay.toISOString().slice(0, 10),
        conversion: {
          newToContacted: total === 0 ? 0 : reached.contacted / total,
          contactedToQualified: reached.contacted === 0 ? 0 : reached.qualified / reached.contacted,
          qualifiedToWon: reached.qualified === 0 ? 0 : reached.won / reached.qualified,
        },
        bySource: bySourceRows
          .map((r) => ({ source: r.source as string, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
        lostReasons: lostReasonRows
          .map((r) => ({ reason: r.lostReasonCode ?? 'unknown', count: r._count._all }))
          .sort((a, b) => b.count - a.count),
      };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 4b. Tracking de campañas (UTM): conversión por origen/campaña
  // ---------------------------------------------------------------------------

  /**
   * Leads con UTM agrupados por (origen, campaña) con su tasa de conversión a
   * `won`. Permite ver qué canal/campaña capta y cuál convierte mejor.
   */
  async getLeadsUtm(
    tenantId: string,
    filters?: { from?: string; to?: string },
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<LeadsUtmKpiDto> {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filters?.from) createdAt.gte = parseDate(filters.from, 'from');
    if (filters?.to) {
      const end = parseDate(filters.to, 'to');
      end.setUTCDate(end.getUTCDate() + 1); // `to` inclusivo (hasta fin de ese día)
      createdAt.lt = end;
    }
    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      AND: [
        { OR: [{ utmSource: { not: null } }, { utmCampaign: { not: null } }] },
        leadWhere(scope),
      ],
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
    };

    return this.prisma.withTenant(async (tx) => {
      const [totals, wons] = await Promise.all([
        tx.lead.groupBy({ by: ['utmSource', 'utmCampaign'], where, _count: { _all: true } }),
        tx.lead.groupBy({
          by: ['utmSource', 'utmCampaign'],
          where: { ...where, status: 'won' },
          _count: { _all: true },
        }),
      ]);
      const wonMap = new Map(
        wons.map((w) => [`${w.utmSource ?? ''}|${w.utmCampaign ?? ''}`, w._count._all]),
      );
      const rows = totals
        .map((t) => {
          const total = t._count._all;
          const won = wonMap.get(`${t.utmSource ?? ''}|${t.utmCampaign ?? ''}`) ?? 0;
          return {
            source: t.utmSource ?? '(directo)',
            campaign: t.utmCampaign ?? '(sin campaña)',
            total,
            won,
            conversionRate: total > 0 ? won / total : 0,
          };
        })
        .sort((a, b) => b.total - a.total);
      return { rows, totalTracked: rows.reduce((s, r) => s + r.total, 0) };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 4c. Rendimiento de la web (Web Premium): leads → contrato → MRR
  // ---------------------------------------------------------------------------

  /**
   * Cuánto genera la web pública: leads captados por sus fuentes (`web` =
   * formulario de contacto, `widget` = embebido), cuántos acaban en contrato y el
   * MRR (€/mes) de los contratos vivos originados por esos leads. Por defecto los
   * últimos 90 días.
   */
  async getWebPerformance(
    tenantId: string,
    filters?: { from?: string; to?: string },
  ): Promise<WebPerformanceDto> {
    const now = new Date();
    const defaultTo = startOfDayUtc(now);
    const defaultFrom = new Date(defaultTo.getTime() - 90 * 24 * 60 * 60 * 1000);
    const fromDate = filters?.from ? parseDate(filters.from, 'from') : defaultFrom;
    const toExclusive = filters?.to
      ? new Date(parseDate(filters.to, 'to').getTime() + 24 * 60 * 60 * 1000)
      : new Date(defaultTo.getTime() + 24 * 60 * 60 * 1000);

    const WEB_SOURCES: { source: string; label: string }[] = [
      { source: 'web', label: 'Formulario de la web' },
      { source: 'widget', label: 'Widget embebido' },
    ];
    const sourceKeys = WEB_SOURCES.map((s) => s.source);

    return this.prisma.withTenant(async (tx) => {
      const leads = await tx.lead.findMany({
        where: {
          deletedAt: null,
          source: { in: sourceKeys },
          createdAt: { gte: fromDate, lt: toExclusive },
        },
        select: {
          source: true,
          status: true,
          convertedContract: { select: { priceMonthly: true, status: true } },
        },
      });

      const acc = new Map<string, { leads: number; won: number; mrr: number }>();
      for (const key of sourceKeys) acc.set(key, { leads: 0, won: 0, mrr: 0 });
      for (const l of leads) {
        const bucket = acc.get(l.source) ?? { leads: 0, won: 0, mrr: 0 };
        bucket.leads += 1;
        const contract = l.convertedContract;
        // «Ganado» = convertido en contrato (o marcado won). El MRR solo cuenta
        // contratos vivos (active/ending) para no inflar con bajas.
        if (contract || l.status === 'won') bucket.won += 1;
        if (contract && (contract.status === 'active' || contract.status === 'ending')) {
          bucket.mrr += Number(contract.priceMonthly);
        }
        acc.set(l.source, bucket);
      }

      const bySource = WEB_SOURCES.map((s) => {
        const b = acc.get(s.source)!;
        return { source: s.source, label: s.label, leads: b.leads, won: b.won, mrr: b.mrr };
      });
      const totalLeads = bySource.reduce((s, r) => s + r.leads, 0);
      const totalWon = bySource.reduce((s, r) => s + r.won, 0);
      const totalMrr = bySource.reduce((s, r) => s + r.mrr, 0);

      return {
        from: fromDate.toISOString().slice(0, 10),
        to: new Date(toExclusive.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        totalLeads,
        totalWon,
        conversionRate: totalLeads > 0 ? totalWon / totalLeads : 0,
        totalMrr,
        bySource,
      };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 5. Inquilinos (recuentos)
  // ---------------------------------------------------------------------------
  async getCustomerStats(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<CustomerStatsKpiDto> {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    // Con local: los inquilinos que tienen (o tuvieron) algún contrato en él.
    const inScope: Prisma.CustomerWhereInput = scope.ids
      ? { contracts: { some: contractWhere(scope) } }
      : {};

    return this.prisma.withTenant(async (tx) => {
      const [total, withActiveContract, newThisMonth] = await Promise.all([
        tx.customer.count({ where: { deletedAt: null, ...inScope } }),
        tx.customer.count({
          where: {
            deletedAt: null,
            contracts: {
              some: {
                status: { in: ['active', 'ending'] },
                deletedAt: null,
                ...contractWhere(scope),
              },
            },
          },
        }),
        tx.customer.count({
          where: { deletedAt: null, createdAt: { gte: startOfMonth }, ...inScope },
        }),
      ]);
      return { total, withActiveContract, newThisMonth };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 5b. Ingresos por mes (facturado vs cobrado, histórico)
  // ---------------------------------------------------------------------------

  /**
   * Serie de los últimos `months` meses con lo **facturado** (facturas emitidas
   * en el mes, por fecha de emisión, estados no borrador/anulada) y lo
   * **cobrado** (pagos con éxito en el mes, por fecha de cobro). Permite ver la
   * tendencia y comparar meses (lo que el Resumen no muestra: solo el mes actual).
   */
  async getMonthlyRevenue(
    tenantId: string,
    opts: { months?: number; from?: string; to?: string } = {},
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<MonthlyRevenueKpiDto> {
    // Lista de meses (más antiguo → actual): rango from/to o últimos N.
    const list = resolveMonthList(opts);
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const fromDate = monthStartUtc(first.year, first.month);
    // Exclusivo: primer día del mes siguiente al último del rango.
    const toExclusive = nextMonthStartUtc(last.year, last.month);

    const [invoices, payments] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.invoice.findMany({
            where: {
              tenantId,
              deletedAt: null,
              status: {
                in: ['issued', 'paid', 'overdue', 'refunded', 'partially_refunded', 'rectified'],
              },
              // La fianza no es un ingreso (se devuelve): fuera de lo facturado y cobrado.
              kind: 'invoice',
              issueDate: { gte: fromDate, lt: toExclusive },
              ...invoiceWhere(scope),
            },
            select: { issueDate: true, total: true },
          }),
          tx.payment.findMany({
            where: {
              tenantId,
              status: { in: ['succeeded', 'partially_refunded', 'refunded'] }, // neto de reembolsos
              paidAt: { gte: fromDate, lt: toExclusive },
              invoice: { kind: 'invoice', ...invoiceWhere(scope) },
              methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] }, // una compensación con abono no es dinero cobrado
            },
            select: { paidAt: true, amount: true, refundedAmount: true },
          }),
        ]),
      tenantId,
    );

    const invoicedByKey = new Map<string, number>();
    for (const inv of invoices) {
      if (!inv.issueDate) continue;
      const key = formatYearMonth(inv.issueDate.getUTCFullYear(), inv.issueDate.getUTCMonth() + 1);
      invoicedByKey.set(key, (invoicedByKey.get(key) ?? 0) + Number(inv.total));
    }
    const collectedByKey = new Map<string, number>();
    for (const p of payments) {
      if (!p.paidAt) continue;
      const key = formatYearMonth(p.paidAt.getUTCFullYear(), p.paidAt.getUTCMonth() + 1);
      collectedByKey.set(
        key,
        (collectedByKey.get(key) ?? 0) + Number(p.amount) - Number(p.refundedAmount),
      );
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const MONTHS_ES = [
      'ene',
      'feb',
      'mar',
      'abr',
      'may',
      'jun',
      'jul',
      'ago',
      'sep',
      'oct',
      'nov',
      'dic',
    ];
    const points = list.map(({ year, month, key }) => ({
      yearMonth: key,
      label: `${MONTHS_ES[month - 1]} ${(year % 100).toString().padStart(2, '0')}`,
      invoiced: round2(invoicedByKey.get(key) ?? 0),
      collected: round2(collectedByKey.get(key) ?? 0),
    }));
    return { points };
  }

  // ---------------------------------------------------------------------------
  // 6. Revenue management (RevPAU, length-of-stay, LTV)
  // ---------------------------------------------------------------------------
  async getRevenue(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<RevenueKpiDto> {
    return this.prisma.withTenant(async (tx) => {
      const units = unitWhere(scope);
      const [totalUnits, occupiedUnits, live, contracts, ltvRows] = await Promise.all([
        tx.unit.count({ where: units }),
        tx.unit.count({ where: { ...units, status: 'occupied' } }),
        liveMrr(tx, scope),
        tx.contract.findMany({
          where: { signedAt: { not: null }, deletedAt: null, ...contractWhere(scope) },
          select: LIFECYCLE_SELECT,
        }),
        tx.invoice.groupBy({
          by: ['customerId'],
          where: {
            customerId: { not: null },
            deletedAt: null,
            kind: 'invoice',
            ...invoiceWhere(scope),
          },
          _sum: { amountPaid: true },
        }),
      ]);

      const mrr = live.mrr;
      const revPau = totalUnits > 0 ? mrr / totalUnits : 0;

      // Estancia: de la firma (o el inicio) a la baja; los vivos, hasta hoy.
      const now = Date.now();
      const stayDays = contracts
        .map((c) => contractLifecycle(c))
        .filter((l): l is NonNullable<typeof l> => l !== null)
        .map((l) => Math.max(0, ((l.end?.getTime() ?? now) - l.begin.getTime()) / 86_400_000));
      const avgLengthOfStayDays =
        stayDays.length > 0 ? stayDays.reduce((a, b) => a + b, 0) / stayDays.length : 0;

      const ltvs = ltvRows.map((r) => Number(r._sum.amountPaid ?? 0)).filter((v) => v > 0);
      const avgCustomerLtv = ltvs.length > 0 ? ltvs.reduce((a, b) => a + b, 0) / ltvs.length : 0;

      return {
        mrr,
        totalUnits,
        occupiedUnits,
        revPau: Math.round(revPau * 100) / 100,
        avgLengthOfStayDays: Math.round(avgLengthOfStayDays),
        avgCustomerLtv: Math.round(avgCustomerLtv * 100) / 100,
      };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 4d. Checklist de SEO on-page: agrega señales ya existentes en una vista
  // única accionable. No es gated por `web_premium` — los tenants base ven
  // sus 5 checks alcanzables + un upsell si aún no tienen la feature.
  // ---------------------------------------------------------------------------

  private async hasWebPremium(tenantId: string): Promise<boolean> {
    const [subscription, overrides] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId, ...liveOverrideWhere() },
        select: { feature: true, enabled: true },
      }),
    ]);
    const base = subscription ? resolvePlanFeatures(subscription.plan) : [];
    const features = effectiveFeaturesFromList(
      base,
      overrides as { feature: TenantFeature; enabled: boolean }[],
    );
    return features.includes('web_premium');
  }

  async getSeoChecklist(tenantId: string): Promise<SeoChecklistDto> {
    const [hasWebPremium, tenant, facilities, faqCount, testimonialCount, blogCount] =
      await Promise.all([
        this.hasWebPremium(tenantId),
        this.admin.tenant.findUnique({
          where: { id: tenantId },
          select: { webHeadline: true, webSections: true, googleReviewUrl: true },
        }),
        this.prisma.withTenant(
          (tx) =>
            tx.facility.findMany({
              where: { tenantId, deletedAt: null, isActive: true },
              select: {
                openingHours: true,
                images: true,
                address: true,
                latitude: true,
                contactPhone: true,
              },
            }),
          tenantId,
        ),
        this.prisma.withTenant(
          (tx) => tx.faqEntry.count({ where: { tenantId, isPublished: true } }),
          tenantId,
        ),
        this.prisma.withTenant(
          (tx) =>
            tx.review.count({
              where: {
                tenantId,
                status: 'submitted',
                npsScore: { gte: 9 },
                comment: { not: null },
              },
            }),
          tenantId,
        ),
        this.prisma.withTenant(
          (tx) => tx.blogPost.count({ where: { tenantId, isPublished: true } }),
          tenantId,
        ),
      ]);

    const facilityCount = facilities.length;
    const withoutHours = facilities.filter(
      (f) => !Object.values((f.openingHours as Record<string, unknown>) ?? {}).some(Boolean),
    ).length;
    const withoutImages = facilities.filter((f) => f.images.length === 0).length;
    const withoutAddress = facilities.filter((f) => !f.address && f.latitude == null).length;
    const withoutPhone = facilities.filter((f) => !f.contactPhone).length;

    const perFacilityDetail = (missing: number): string | null => {
      if (facilityCount === 0) return 'Añade tu primer local';
      if (missing === 0) return null;
      return `${missing} de ${facilityCount} locales sin completar`;
    };

    const base: SeoChecklistItemDto[] = [
      {
        id: 'opening_hours',
        label: 'Horario de apertura configurado',
        description: 'Muestra "Abierto ahora" en la web y evita horarios ambiguos en Google.',
        done: facilityCount > 0 && withoutHours === 0,
        detail: perFacilityDetail(withoutHours),
        href: '/facilities',
      },
      {
        id: 'facility_images',
        label: 'Fotos del local subidas',
        description:
          'Las páginas con fotos reales convierten más y refuerzan el SelfStorage schema.',
        done: facilityCount > 0 && withoutImages === 0,
        detail: perFacilityDetail(withoutImages),
        href: '/facilities',
      },
      {
        id: 'facility_address',
        label: 'Dirección o coordenadas del local',
        description: 'Necesario para el mapa embebido y para el SEO local (NAP consistency).',
        done: facilityCount > 0 && withoutAddress === 0,
        detail: perFacilityDetail(withoutAddress),
        href: '/facilities',
      },
      {
        id: 'facility_contact',
        label: 'Teléfono de contacto',
        description:
          'Activa el botón de WhatsApp y es obligatorio para un negocio local de confianza.',
        done: facilityCount > 0 && withoutPhone === 0,
        detail: perFacilityDetail(withoutPhone),
        href: '/facilities',
      },
      {
        id: 'google_review_link',
        label: 'Enlace a reseñas de Google',
        description: 'Muestra la insignia de reseñas en la web pública (confianza + SEO local).',
        done: !!tenant?.googleReviewUrl,
        detail: null,
        href: '/reviews',
      },
    ];

    const premium: SeoChecklistItemDto[] = [
      {
        id: 'custom_headline',
        label: 'Titular propio de la web',
        description: 'Sustituye el titular genérico por uno que describa tu negocio y tu zona.',
        done: !!tenant?.webHeadline?.trim(),
        detail: null,
        href: '/settings/web',
      },
      {
        id: 'faq_published',
        label: 'Preguntas frecuentes publicadas',
        description:
          'Alimenta el JSON-LD FAQPage: puede generar resultados enriquecidos en Google.',
        done: faqCount > 0,
        detail: null,
        href: '/settings/faq',
      },
      {
        id: 'testimonials_section',
        label: 'Sección de testimonios activa y con contenido',
        description:
          'Reseñas reales (NPS≥9) alimentan el AggregateRating del schema de tu negocio.',
        done:
          !!(tenant?.webSections as { testimonials?: boolean } | null)?.testimonials &&
          testimonialCount > 0,
        detail: null,
        href: '/settings/web',
      },
      {
        id: 'contact_form',
        label: 'Formulario de contacto activo',
        description: 'Captura leads de quien no reserva a la primera.',
        done: !!(tenant?.webSections as { contact?: boolean } | null)?.contact,
        detail: null,
        href: '/settings/web',
      },
      {
        id: 'blog_active',
        label: 'Al menos una entrada de blog publicada',
        description:
          'Contenido propio indexable — la principal palanca de tráfico orgánico a medio plazo.',
        done: blogCount > 0,
        detail: null,
        href: '/settings/blog',
      },
    ];

    return {
      hasWebPremium,
      base,
      premium,
      baseScore: { done: base.filter((i) => i.done).length, total: base.length },
      premiumScore: { done: premium.filter((i) => i.done).length, total: premium.length },
    };
  }
}
