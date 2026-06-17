import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type {
  AgingKpiDto,
  ChurnKpiDto,
  CustomerStatsKpiDto,
  LeadsFunnelKpiDto,
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
    filters?: { facilityId?: string },
  ): Promise<OccupancyKpiDto> {
    const facilityFilter: Prisma.UnitWhereInput = filters?.facilityId
      ? { facilityId: filters.facilityId }
      : {};

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
            where: {
              status: 'active',
              ...(filters?.facilityId ? { unit: { facilityId: filters.facilityId } } : {}),
            },
            select: { priceMonthly: true },
          }),
          tx.facility.findMany({
            where: {
              deletedAt: null,
              ...(filters?.facilityId ? { id: filters.facilityId } : {}),
            },
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
