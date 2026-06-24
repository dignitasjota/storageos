import { Injectable } from '@nestjs/common';

import { resolveFacilityFilter } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';

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
} from '@storageos/shared';

type AgingBucketRange = '0-30' | '30-60' | '60-90' | '+90';

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value);
}

function parseYearMonth(yearMonth: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) {
    throw new Error(`yearMonth invalido: ${yearMonth}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`yearMonth invalido: ${yearMonth}`);
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

function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Fecha invalida: ${value}`);
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function bucketForDaysOverdue(days: number): AgingBucketRange {
  if (days < 30) return '0-30';
  if (days < 60) return '30-60';
  if (days < 90) return '60-90';
  return '+90';
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // 1. Ocupacion
  // ---------------------------------------------------------------------------
  async getOccupancy(
    tenantId: string,
    filters?: { facilityId?: string; facilityScope?: string[] | null },
  ): Promise<OccupancyKpiDto> {
    // Permisos por local: combina el filtro explícito con el scope del usuario.
    const facFilter = resolveFacilityFilter(filters?.facilityScope, filters?.facilityId);
    const facIds = facFilter === null ? [] : facFilter; // null = pedido fuera de scope → vacío
    const facilityFilter: Prisma.UnitWhereInput = facIds ? { facilityId: { in: facIds } } : {};
    const facilityIdWhere = facIds ? { id: { in: facIds } } : {};
    const contractFacilityWhere = facIds ? { unit: { facilityId: { in: facIds } } } : {};

    return this.prisma.withTenant(async (tx) => {
      const [byStatus, byUnitType, unitTypes, activeContracts, facilities, facilityCounts] =
        await Promise.all([
          tx.unit.groupBy({
            by: ['status'],
            where: facilityFilter,
            _count: { _all: true },
          }),
          tx.unit.groupBy({
            by: ['unitTypeId'],
            where: facilityFilter,
            _count: { _all: true },
          }),
          tx.unitType.findMany({
            select: { id: true, defaultPriceMonthly: true },
          }),
          tx.contract.findMany({
            where: { status: 'active', ...contractFacilityWhere },
            select: { priceMonthly: true },
          }),
          tx.facility.findMany({
            where: { deletedAt: null, ...facilityIdWhere },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          }),
          tx.unit.groupBy({
            by: ['facilityId', 'status'],
            where: facilityFilter,
            _count: { _all: true },
          }),
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

      const physicalOccupancy = totalUnits === 0 ? 0 : occupiedUnits / totalUnits;

      const mrrActual = activeContracts.reduce((sum, c) => sum + toNumber(c.priceMonthly), 0);

      const unitTypePrice = new Map<string, number>();
      for (const ut of unitTypes) {
        unitTypePrice.set(ut.id, toNumber(ut.defaultPriceMonthly));
      }
      const mrrPotential = byUnitType.reduce((sum, row) => {
        const price = unitTypePrice.get(row.unitTypeId) ?? 0;
        return sum + price * row._count._all;
      }, 0);

      const economicOccupancy = mrrPotential === 0 ? 0 : mrrActual / mrrPotential;

      const perFacility = facilities.map((f) => {
        const total = facilityCounts
          .filter((r) => r.facilityId === f.id)
          .reduce((sum, r) => sum + r._count._all, 0);
        const occupied =
          facilityCounts.find((r) => r.facilityId === f.id && r.status === 'occupied')?._count
            ._all ?? 0;
        return {
          facilityId: f.id,
          facilityName: f.name,
          total,
          occupied,
        };
      });

      return {
        totalUnits,
        occupiedUnits,
        reservedUnits,
        availableUnits,
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
  async getChurn(tenantId: string, filters?: { from?: string; to?: string }): Promise<ChurnKpiDto> {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;

    let fromYear: number;
    let fromMonth: number;
    let toYear: number;
    let toMonth: number;

    if (filters?.from && filters?.to) {
      ({ year: fromYear, month: fromMonth } = parseYearMonth(filters.from));
      ({ year: toYear, month: toMonth } = parseYearMonth(filters.to));
    } else {
      toYear = currentYear;
      toMonth = currentMonth;
      // Ultimos 6 meses incluyendo el actual.
      const fromIndex = currentYear * 12 + (currentMonth - 1) - 5;
      fromYear = Math.floor(fromIndex / 12);
      fromMonth = (fromIndex % 12) + 1;
    }

    // Lista de meses a calcular (orden cronologico).
    const months: { year: number; month: number }[] = [];
    let y = fromYear;
    let m = fromMonth;
    while (y < toYear || (y === toYear && m <= toMonth)) {
      months.push({ year: y, month: m });
      if (m === 12) {
        y += 1;
        m = 1;
      } else {
        m += 1;
      }
    }

    return this.prisma.withTenant(async (tx) => {
      const results = await Promise.all(
        months.map(async ({ year, month }) => {
          const monthStart = monthStartUtc(year, month);
          const monthEnd = nextMonthStartUtc(year, month);

          const [endedInMonth, activeAtStart] = await Promise.all([
            tx.contract.count({
              where: {
                status: 'ended',
                endedAt: { gte: monthStart, lt: monthEnd },
              },
            }),
            tx.contract.count({
              where: {
                startDate: { lt: monthStart },
                OR: [{ endedAt: null }, { endedAt: { gte: monthStart } }],
              },
            }),
          ]);

          const churnRate = activeAtStart === 0 ? 0 : endedInMonth / activeAtStart;
          return {
            yearMonth: formatYearMonth(year, month),
            activeAtStart,
            ended: endedInMonth,
            churnRate,
          };
        }),
      );

      return { months: results };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 3. Aging de facturas pendientes
  // ---------------------------------------------------------------------------
  async getAging(tenantId: string, atDate?: string): Promise<AgingKpiDto> {
    const at = atDate ? parseDate(atDate) : startOfDayUtc(new Date());

    return this.prisma.withTenant(async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: {
          status: { in: ['issued', 'overdue', 'partially_refunded'] },
          deletedAt: null,
          dueDate: { lt: at },
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
          amount: buckets[range].amount,
          invoiceCount: buckets[range].invoiceCount,
        })),
        totalOutstanding,
      };
    }, tenantId);
  }

  // ---------------------------------------------------------------------------
  // 4. Funnel de leads
  // ---------------------------------------------------------------------------
  async getLeadsFunnel(
    tenantId: string,
    filters?: { from?: string; to?: string },
  ): Promise<LeadsFunnelKpiDto> {
    const now = new Date();
    const defaultTo = startOfDayUtc(now);
    const defaultFrom = new Date(defaultTo.getTime() - 30 * 24 * 60 * 60 * 1000);

    const fromDate = filters?.from ? parseDate(filters.from) : defaultFrom;
    // Para incluir el dia "to" entero, sumamos 1 dia y usamos lt.
    const toExclusive = filters?.to
      ? new Date(parseDate(filters.to).getTime() + 24 * 60 * 60 * 1000)
      : new Date(defaultTo.getTime() + 24 * 60 * 60 * 1000);

    const rangeWhere: Prisma.LeadWhereInput = {
      deletedAt: null,
      createdAt: { gte: fromDate, lt: toExclusive },
    };

    return this.prisma.withTenant(async (tx) => {
      const [newCount, contactedCount, qualifiedCount, wonCount, lostCount, bySourceRows] =
        await Promise.all([
          tx.lead.count({ where: { ...rangeWhere, status: 'new' } }),
          // Leads que llegaron al menos a "contacted" (incluye qualified/won/lost si tienen contactedAt).
          tx.lead.count({ where: { ...rangeWhere, contactedAt: { not: null } } }),
          tx.lead.count({ where: { ...rangeWhere, qualifiedAt: { not: null } } }),
          tx.lead.count({ where: { ...rangeWhere, status: 'won' } }),
          tx.lead.count({ where: { ...rangeWhere, status: 'lost' } }),
          tx.lead.groupBy({
            by: ['source'],
            where: rangeWhere,
            _count: { _all: true },
          }),
        ]);

      const totalLeads = newCount + contactedCount + qualifiedCount + wonCount + lostCount;
      const newToContacted = totalLeads === 0 ? 0 : contactedCount / totalLeads;
      const contactedToQualified = contactedCount === 0 ? 0 : qualifiedCount / contactedCount;
      const qualifiedToWon = qualifiedCount === 0 ? 0 : wonCount / qualifiedCount;

      return {
        totals: {
          new: newCount,
          contacted: contactedCount,
          qualified: qualifiedCount,
          won: wonCount,
          lost: lostCount,
        },
        conversion: {
          newToContacted,
          contactedToQualified,
          qualifiedToWon,
        },
        bySource: bySourceRows
          .map((r) => ({ source: r.source as string, count: r._count._all }))
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
  ): Promise<LeadsUtmKpiDto> {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filters?.from) createdAt.gte = parseDate(filters.from);
    if (filters?.to) {
      const end = parseDate(filters.to);
      end.setUTCDate(end.getUTCDate() + 1); // `to` inclusivo (hasta fin de ese día)
      createdAt.lt = end;
    }
    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      OR: [{ utmSource: { not: null } }, { utmCampaign: { not: null } }],
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
  // 5. Inquilinos (recuentos)
  // ---------------------------------------------------------------------------
  async getCustomerStats(tenantId: string): Promise<CustomerStatsKpiDto> {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    return this.prisma.withTenant(async (tx) => {
      const [total, withActiveContract, newThisMonth] = await Promise.all([
        tx.customer.count({ where: { deletedAt: null } }),
        tx.customer.count({
          where: { deletedAt: null, contracts: { some: { status: 'active' } } },
        }),
        tx.customer.count({ where: { deletedAt: null, createdAt: { gte: startOfMonth } } }),
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
              status: { in: ['issued', 'paid', 'overdue', 'refunded', 'partially_refunded'] },
              issueDate: { gte: fromDate, lt: toExclusive },
            },
            select: { issueDate: true, total: true },
          }),
          tx.payment.findMany({
            where: { tenantId, status: 'succeeded', paidAt: { gte: fromDate, lt: toExclusive } },
            select: { paidAt: true, amount: true },
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
      collectedByKey.set(key, (collectedByKey.get(key) ?? 0) + Number(p.amount));
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
  async getRevenue(tenantId: string): Promise<RevenueKpiDto> {
    return this.prisma.withTenant(async (tx) => {
      const [totalUnits, occupiedUnits, activeContracts, stayRows, ltvRows] = await Promise.all([
        tx.unit.count(),
        tx.unit.count({ where: { status: 'occupied' } }),
        tx.contract.findMany({
          where: { status: { in: ['active', 'ending'] }, deletedAt: null },
          select: { priceMonthly: true, discountAmount: true },
        }),
        tx.contract.findMany({
          where: { signedAt: { not: null } },
          select: { signedAt: true, endedAt: true },
        }),
        tx.invoice.groupBy({
          by: ['customerId'],
          where: { customerId: { not: null }, deletedAt: null },
          _sum: { amountPaid: true },
        }),
      ]);

      const mrr = activeContracts.reduce(
        (sum, c) => sum + (Number(c.priceMonthly) - Number(c.discountAmount)),
        0,
      );
      const revPau = totalUnits > 0 ? mrr / totalUnits : 0;

      const stayDays = stayRows.map((c) => {
        const start = c.signedAt!.getTime();
        const end = (c.endedAt ?? new Date()).getTime();
        return Math.max(0, (end - start) / 86_400_000);
      });
      const avgLengthOfStayDays =
        stayDays.length > 0 ? stayDays.reduce((a, b) => a + b, 0) / stayDays.length : 0;

      const ltvs = ltvRows.map((r) => Number(r._sum.amountPaid ?? 0)).filter((v) => v > 0);
      const avgCustomerLtv = ltvs.length > 0 ? ltvs.reduce((a, b) => a + b, 0) / ltvs.length : 0;

      return {
        mrr: Math.round(mrr * 100) / 100,
        totalUnits,
        occupiedUnits,
        revPau: Math.round(revPau * 100) / 100,
        avgLengthOfStayDays: Math.round(avgLengthOfStayDays),
        avgCustomerLtv: Math.round(avgCustomerLtv * 100) / 100,
      };
    }, tenantId);
  }
}
