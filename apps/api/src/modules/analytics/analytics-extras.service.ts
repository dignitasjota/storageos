import { BadRequestException, Injectable } from '@nestjs/common';

import { todayInTimezone, zonedNextDayStart } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import {
  ALL_FACILITIES,
  contractLifecycle,
  contractWhere,
  invoiceWhere,
  leadWhere,
  LIFECYCLE_SELECT,
  LIVE_CONTRACT_WHERE,
  MONTHLY_FEE_SELECT,
  monthlyFee,
  SIGNED_CONTRACT_WHERE,
  unitWhere,
  type AnalyticsScope,
} from './analytics-scope';
import { AnalyticsTrendsService } from './analytics-trends.service';
import {
  contractMoves,
  currentYearMonth,
  invoicedBetween,
  receivables,
  tenantTimezone,
  unitCounts,
  zonedMonthStart,
} from './business-metrics';
import { InsightsService } from './insights.service';

import type {
  AnalyticsHeadlineDto,
  ArrearsBreakdownDto,
  ChurnBreakdownDto,
  ForecastScenarioDto,
  ForecastScenarioKey,
  ForecastScenariosDto,
  ForecastSegmentDto,
  PortfolioGapDto,
  TenureBucket,
  UnitEconomicsDto,
  UnitEconomicsRowDto,
} from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
/** Meses cerrados que se miran para las medias de altas y bajas. */
const TRAILING_MONTHS = 6;
/** Hasta dónde se busca cuándo se llenaría un local (5 años). */
const FULL_HORIZON_MONTHS = 60;
const MONTH_RANGE_MAX = 36;

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

function ym(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseMonth(value: string, field: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new BadRequestException({
      code: 'invalid_date',
      message: `«${field}» debe tener el formato AAAA-MM`,
    });
  }
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

function tenureBucket(months: number): TenureBucket {
  if (months < 3) return 'lt3';
  if (months < 6) return '3to6';
  if (months < 12) return '6to12';
  if (months < 24) return '12to24';
  return 'gt24';
}

/**
 * Cifras que se añaden a Analítica: el resumen del mes, la deuda por inquilino
 * y por local, lo que la cartera paga por debajo del precio de hoy, escenarios
 * de la previsión, el rendimiento por m² y lo que entra y sale cada mes.
 */
@Injectable()
export class AnalyticsExtrasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trends: AnalyticsTrendsService,
    private readonly insights: InsightsService,
  ) {}

  /** Cómo va el mes en curso frente al pasado hasta el mismo día. */
  async getHeadline(
    tenantId: string,
    scope: AnalyticsScope,
    moneyScope: AnalyticsScope,
    moneyVisible: boolean,
  ): Promise<AnalyticsHeadlineDto> {
    const [history, figures] = await Promise.all([
      this.trends.getOccupancyHistory(tenantId, 2, scope),
      this.prisma.withTenant(async (tx) => {
        const timezone = await tenantTimezone(tx, tenantId);
        const today = todayInTimezone(timezone);
        const { year, month } = currentYearMonth(timezone);
        const day = Number(dayKey(today).slice(8, 10));
        const monthStart = zonedMonthStart(year, month, timezone);
        const end = zonedNextDayStart(dayKey(today), timezone);
        // El mes pasado hasta el mismo día (o su último día, si es más corto).
        const prevStart = zonedMonthStart(year, month - 1, timezone);
        const prevLastDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
        const prevEnd = zonedNextDayStart(
          `${ym(year, month - 1)}-${String(Math.min(day, prevLastDay)).padStart(2, '0')}`,
          timezone,
        );
        const leadsIn = (from: Date, to: Date) =>
          tx.lead.count({
            where: { deletedAt: null, createdAt: { gte: from, lt: to }, ...leadWhere(scope) },
          });
        const [invoiced, invoicedPrev, moves, leads, leadsPrev, debt, counts] = await Promise.all([
          moneyVisible ? invoicedBetween(tx, moneyScope, monthStart, end) : null,
          moneyVisible ? invoicedBetween(tx, moneyScope, prevStart, prevEnd) : null,
          contractMoves(tx, scope, monthStart, end),
          leadsIn(monthStart, end),
          leadsIn(prevStart, prevEnd),
          moneyVisible ? receivables(tx, moneyScope, today) : null,
          unitCounts(tx, scope),
        ]);
        return {
          yearMonth: ym(year, month),
          day,
          invoiced,
          invoicedPrev,
          moves,
          leads,
          leadsPrev,
          overdue: debt?.overdue ?? null,
          occupancy: counts.total === 0 ? 0 : counts.occupied / counts.total,
        };
      }, tenantId),
    ]);
    const prev = history.points.length >= 2 ? history.points[0]! : null;
    return {
      yearMonth: figures.yearMonth,
      day: figures.day,
      invoiced: figures.invoiced,
      invoicedPrev: figures.invoicedPrev,
      occupancy: figures.occupancy,
      occupancyPrev: prev && prev.totalUnits > 0 ? prev.occupancy : null,
      moveIns: figures.moves.moveIns,
      moveOuts: figures.moves.moveOuts,
      leads: figures.leads,
      leadsPrev: figures.leadsPrev,
      overdue: figures.overdue,
    };
  }

  /** Deuda vencida por inquilino y por local, y cuánto se tarda en cobrar. */
  async getArrearsBreakdown(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<ArrearsBreakdownDto> {
    return this.prisma.withTenant(async (tx) => {
      const today = todayInTimezone(await tenantTimezone(tx, tenantId));
      const since = new Date(today.getTime() - 90 * DAY);
      const [open, paid] = await Promise.all([
        tx.invoice.findMany({
          where: {
            status: { in: ['issued', 'overdue', 'partially_refunded'] },
            deletedAt: null,
            kind: 'invoice',
            dueDate: { lt: today },
            ...invoiceWhere(scope),
          },
          select: {
            total: true,
            amountPaid: true,
            dueDate: true,
            facilityId: true,
            customerId: true,
            customer: {
              select: { customerType: true, firstName: true, lastName: true, companyName: true },
            },
            contract: { select: { unit: { select: { facilityId: true } } } },
          },
        }),
        tx.invoice.findMany({
          where: {
            status: 'paid',
            deletedAt: null,
            kind: 'invoice',
            total: { gt: 0 },
            paidAt: { gte: since },
            ...invoiceWhere(scope),
          },
          select: { issueDate: true, dueDate: true, paidAt: true },
        }),
      ]);

      const customers = new Map<
        string,
        { name: string; amount: number; invoices: number; oldest: number }
      >();
      const facilities = new Map<string | null, { amount: number; invoices: number }>();
      for (const row of open) {
        const pending = Number(row.total) - Number(row.amountPaid);
        if (pending <= 0) continue;
        const days = Math.floor((today.getTime() - row.dueDate!.getTime()) / DAY);
        if (row.customerId && row.customer) {
          const c = customers.get(row.customerId) ?? {
            name: customerName(row.customer),
            amount: 0,
            invoices: 0,
            oldest: 0,
          };
          c.amount += pending;
          c.invoices += 1;
          c.oldest = Math.max(c.oldest, days);
          customers.set(row.customerId, c);
        }
        const facilityId = row.contract?.unit.facilityId ?? row.facilityId ?? null;
        const f = facilities.get(facilityId) ?? { amount: 0, invoices: 0 };
        f.amount += pending;
        f.invoices += 1;
        facilities.set(facilityId, f);
      }
      const ids = [...facilities.keys()].filter((id): id is string => id !== null);
      const names = new Map(
        (
          await tx.facility.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        ).map((f) => [f.id, f.name]),
      );

      const late: number[] = [];
      const toCollect: number[] = [];
      for (const row of paid) {
        if (!row.paidAt || !row.issueDate) continue;
        toCollect.push(Math.max(0, (row.paidAt.getTime() - row.issueDate.getTime()) / DAY));
        if (row.dueDate)
          late.push(Math.max(0, (row.paidAt.getTime() - row.dueDate.getTime()) / DAY));
      }
      const mean = (list: number[]) =>
        list.length === 0
          ? null
          : Math.round((list.reduce((s, n) => s + n, 0) / list.length) * 10) / 10;

      return {
        byCustomer: [...customers.entries()]
          .sort((a, b) => b[1].amount - a[1].amount)
          .slice(0, 10)
          .map(([customerId, c]) => ({
            customerId,
            customerName: c.name,
            amount: round2(c.amount),
            invoices: c.invoices,
            oldestDays: c.oldest,
          })),
        customerCount: customers.size,
        byFacility: [...facilities.entries()]
          .map(([facilityId, f]) => ({
            facilityId,
            facilityName: facilityId ? (names.get(facilityId) ?? 'Local borrado') : 'Sin local',
            amount: round2(f.amount),
            invoices: f.invoices,
          }))
          .sort((a, b) => b.amount - a.amount),
        avgDaysToCollect: mean(toCollect),
        avgDaysLate: mean(late),
        collectedInvoices: toCollect.length,
      };
    }, tenantId);
  }

  /** Contratos en vigor que pagan menos que el precio de hoy de su trastero. */
  async getPortfolioGap(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<PortfolioGapDto> {
    return this.prisma.withTenant(async (tx) => {
      const today = todayInTimezone(await tenantTimezone(tx, tenantId));
      const contracts = await tx.contract.findMany({
        where: { AND: [LIVE_CONTRACT_WHERE, contractWhere(scope)] },
        select: {
          id: true,
          contractNumber: true,
          customerId: true,
          priceMonthly: true,
          signedAt: true,
          startDate: true,
          customer: {
            select: { customerType: true, firstName: true, lastName: true, companyName: true },
          },
          unit: {
            select: { code: true, basePriceMonthly: true, facility: { select: { name: true } } },
          },
        },
      });
      const below = contracts.filter(
        (c) => Number(c.unit.basePriceMonthly) - Number(c.priceMonthly) >= 0.5,
      );
      const changes = await tx.contractEvent.findMany({
        where: { contractId: { in: below.map((c) => c.id) }, eventType: 'price_changed' },
        select: { contractId: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
      });
      const lastChange = new Map<string, Date>();
      for (const e of changes)
        if (!lastChange.has(e.contractId)) lastChange.set(e.contractId, e.occurredAt);

      const rows = below
        .map((c) => {
          const paying = Number(c.priceMonthly);
          const listPrice = Number(c.unit.basePriceMonthly);
          const since = lastChange.get(c.id) ?? c.signedAt ?? c.startDate;
          return {
            contractId: c.id,
            contractNumber: c.contractNumber,
            customerId: c.customerId,
            customerName: customerName(c.customer),
            unitCode: c.unit.code,
            facilityName: c.unit.facility.name,
            paying: round2(paying),
            listPrice: round2(listPrice),
            gap: round2(listPrice - paying),
            gapPct: paying > 0 ? Math.round(((listPrice - paying) / paying) * 1000) / 10 : 0,
            since: dayKey(since),
            monthsSince: Math.max(
              0,
              Math.floor((today.getTime() - since.getTime()) / (30.44 * DAY)),
            ),
          };
        })
        .sort((a, b) => b.gap - a.gap);
      return {
        rows: rows.slice(0, 200),
        totalGapMonthly: round2(rows.reduce((s, r) => s + r.gap, 0)),
        liveContracts: contracts.length,
      };
    }, tenantId);
  }

  /** Rendimiento de cada tipo de trastero: cuotas por m² y frente al precio de hoy. */
  async getUnitEconomics(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
  ): Promise<UnitEconomicsDto> {
    const { units, contracts } = await this.prisma.withTenant(
      async (tx) => ({
        units: await tx.unit.findMany({
          where: unitWhere(scope),
          select: {
            id: true,
            unitTypeId: true,
            areaM2: true,
            basePriceMonthly: true,
            unitType: { select: { name: true } },
          },
        }),
        contracts: await tx.contract.findMany({
          where: { AND: [LIVE_CONTRACT_WHERE, contractWhere(scope)] },
          select: { unitId: true, ...MONTHLY_FEE_SELECT },
        }),
      }),
      tenantId,
    );
    const fees = new Map<string, number>();
    for (const c of contracts) fees.set(c.unitId, (fees.get(c.unitId) ?? 0) + monthlyFee(c));

    type Acc = {
      name: string;
      units: number;
      occupied: number;
      area: number;
      occupiedArea: number;
      revenue: number;
      listSum: number;
    };
    const byType = new Map<string, Acc>();
    const empty = (name: string): Acc => ({
      name,
      units: 0,
      occupied: 0,
      area: 0,
      occupiedArea: 0,
      revenue: 0,
      listSum: 0,
    });
    const total = empty('');
    for (const u of units) {
      const acc = byType.get(u.unitTypeId) ?? empty(u.unitType.name);
      const area = Number(u.areaM2 ?? 0);
      const fee = fees.get(u.id);
      for (const a of [acc, total]) {
        a.units += 1;
        a.area += area;
        if (fee !== undefined) {
          a.occupied += 1;
          a.occupiedArea += area;
          a.revenue += fee;
          a.listSum += Number(u.basePriceMonthly);
        }
      }
      byType.set(u.unitTypeId, acc);
    }
    const figures = (a: Acc): Omit<UnitEconomicsRowDto, 'unitTypeId' | 'name'> => {
      const avgFee = a.occupied > 0 ? a.revenue / a.occupied : null;
      const avgList = a.occupied > 0 ? a.listSum / a.occupied : null;
      return {
        units: a.units,
        occupied: a.occupied,
        areaM2: round2(a.area),
        occupiedAreaM2: round2(a.occupiedArea),
        revenueMonthly: round2(a.revenue),
        revenuePerRentedM2: a.occupiedArea > 0 ? round2(a.revenue / a.occupiedArea) : null,
        revenuePerM2: a.area > 0 ? round2(a.revenue / a.area) : null,
        avgFee: avgFee === null ? null : round2(avgFee),
        avgListPrice: avgList === null ? null : round2(avgList),
        feeVsListPct:
          avgFee !== null && avgList ? Math.round((avgFee / avgList - 1) * 1000) / 10 : null,
      };
    };
    return {
      rows: [...byType.entries()]
        .map(([unitTypeId, a]) => ({ unitTypeId, name: a.name, ...figures(a) }))
        .sort((a, b) => b.revenueMonthly - a.revenueMonthly || a.name.localeCompare(b.name)),
      totals: figures(total),
    };
  }

  /** Cuotas que entran y salen cada mes y cuánto llevaban los que se fueron. */
  async getChurnBreakdown(
    tenantId: string,
    filters: { from?: string; to?: string },
    scope: AnalyticsScope = ALL_FACILITIES,
    moneyVisible = true,
  ): Promise<ChurnBreakdownDto> {
    const { contracts, timezone } = await this.prisma.withTenant(
      async (tx) => ({
        timezone: await tenantTimezone(tx, tenantId),
        contracts: await tx.contract.findMany({
          where: { AND: [SIGNED_CONTRACT_WHERE, contractWhere(scope)] },
          select: { ...LIFECYCLE_SELECT, ...MONTHLY_FEE_SELECT },
        }),
      }),
      tenantId,
    );
    const current = currentYearMonth(timezone);
    const curIdx = current.year * 12 + current.month - 1;
    let startIdx = curIdx - 11;
    let endIdx = curIdx;
    if (filters.from && filters.to) {
      const a = parseMonth(filters.from, 'from');
      const b = parseMonth(filters.to, 'to');
      startIdx = Math.min(a, b);
      endIdx = Math.min(curIdx, Math.max(a, b));
      if (startIdx > endIdx) startIdx = endIdx;
      if (endIdx - startIdx + 1 > MONTH_RANGE_MAX) startIdx = endIdx - (MONTH_RANGE_MAX - 1);
    }
    const lives = contracts
      .map((c) => ({ life: contractLifecycle(c), fee: monthlyFee(c) }))
      .filter((l) => l.life !== null) as { life: { begin: Date; end: Date | null }; fee: number }[];

    const rangeStart = zonedMonthStart(Math.floor(startIdx / 12), (startIdx % 12) + 1, timezone);
    const rangeEnd = zonedMonthStart(Math.floor(endIdx / 12), (endIdx % 12) + 2, timezone);
    const months: ChurnBreakdownDto['months'] = [];
    for (let idx = startIdx; idx <= endIdx; idx++) {
      const year = Math.floor(idx / 12);
      const month = (idx % 12) + 1;
      const start = zonedMonthStart(year, month, timezone).getTime();
      const end = zonedMonthStart(year, month + 1, timezone).getTime();
      let gained = 0;
      let lost = 0;
      for (const { life, fee } of lives) {
        const b = life.begin.getTime();
        const e = life.end?.getTime() ?? null;
        if (b >= start && b < end) gained += fee;
        if (e !== null && e >= start && e < end) lost += fee;
      }
      months.push({
        yearMonth: ym(year, month),
        mrrGained: moneyVisible ? round2(gained) : null,
        mrrLost: moneyVisible ? round2(lost) : null,
      });
    }

    const order: TenureBucket[] = ['lt3', '3to6', '6to12', '12to24', 'gt24'];
    const tenure = new Map(order.map((b) => [b, 0]));
    let ended = 0;
    for (const { life } of lives) {
      if (!life.end || life.end < rangeStart || life.end >= rangeEnd) continue;
      ended += 1;
      const months = (life.end.getTime() - life.begin.getTime()) / (30.44 * DAY);
      const bucket = tenureBucket(months);
      tenure.set(bucket, (tenure.get(bucket) ?? 0) + 1);
    }
    return {
      months,
      tenure: order.map((bucket) => ({ bucket, ended: tenure.get(bucket) ?? 0 })),
      ended,
    };
  }

  /**
   * Tres escenarios de la previsión (con más bajas y menos altas, el esperado y
   * al revés) con el mes en que te llenarías, y la misma cuenta por local y por
   * tipo de trastero.
   */
  async getForecastScenarios(
    tenantId: string,
    scope: AnalyticsScope = ALL_FACILITIES,
    moneyVisible = true,
  ): Promise<ForecastScenariosDto> {
    const [base, data] = await Promise.all([
      this.insights.getRevenueForecast(tenantId, { months: 12 }, scope),
      this.prisma.withTenant(async (tx) => {
        const timezone = await tenantTimezone(tx, tenantId);
        const [contracts, units, counts] = await Promise.all([
          tx.contract.findMany({
            where: { AND: [SIGNED_CONTRACT_WHERE, contractWhere(scope)] },
            select: {
              ...LIFECYCLE_SELECT,
              unit: { select: { facilityId: true, unitTypeId: true } },
            },
          }),
          tx.unit.findMany({
            where: unitWhere(scope),
            select: {
              status: true,
              facilityId: true,
              unitTypeId: true,
              facility: { select: { name: true } },
              unitType: { select: { name: true } },
            },
          }),
          unitCounts(tx, scope),
        ]);
        return { timezone, contracts, units, counts };
      }, tenantId),
    ]);

    const { year, month } = currentYearMonth(data.timezone);
    const capacity = base.current.totalUnits;
    const avgValue = base.assumptions.avgContractValue ?? 0;
    const churn = base.assumptions.monthlyChurnRate;
    const adds = base.assumptions.avgMonthlyNewContracts;

    const project = (
      key: ForecastScenarioKey,
      rate: number,
      perMonth: number,
    ): ForecastScenarioDto => {
      const points: ForecastScenarioDto['points'] = [];
      let active = base.current.activeContracts;
      let fullBy: string | null = capacity > 0 && active >= capacity ? ym(year, month) : null;
      for (let m = 1; m <= FULL_HORIZON_MONTHS; m++) {
        active = Math.max(0, Math.min(capacity, active - active * rate + perMonth));
        if (fullBy === null && capacity > 0 && active >= capacity - 0.5)
          fullBy = ym(year, month + m);
        if (m <= 12) {
          points.push({
            yearMonth: ym(year, month + m),
            contracts: Math.round(active),
            occupancy: capacity > 0 ? Math.round((active / capacity) * 100) / 100 : 0,
            mrr: moneyVisible ? round2(active * avgValue) : null,
          });
        }
      }
      return { key, churnRate: rate, adds: round2(perMonth), points, fullBy };
    };

    // Altas y bajas de cada local y tipo en los meses cerrados.
    const lives = data.contracts
      .map((c) => ({ life: contractLifecycle(c), unit: c.unit }))
      .filter((l) => l.life !== null) as {
      life: { begin: Date; end: Date | null };
      unit: { facilityId: string; unitTypeId: string };
    }[];
    const firstBegin = lives.reduce<number | null>(
      (min, l) => (min === null || l.life.begin.getTime() < min ? l.life.begin.getTime() : min),
      null,
    );
    const windowStart = zonedMonthStart(year, month - TRAILING_MONTHS, data.timezone).getTime();
    const windowEnd = zonedMonthStart(year, month, data.timezone).getTime();
    let historyMonths = 0;
    for (let i = 1; i <= TRAILING_MONTHS; i++) {
      const end = zonedMonthStart(year, month - i + 1, data.timezone).getTime();
      if (firstBegin !== null && end > firstBegin) historyMonths += 1;
    }
    const net = new Map<string, number>();
    const bump = (key: string, n: number) => net.set(key, (net.get(key) ?? 0) + n);
    for (const { life, unit } of lives) {
      const b = life.begin.getTime();
      const e = life.end?.getTime() ?? null;
      for (const key of [`f:${unit.facilityId}`, `t:${unit.unitTypeId}`]) {
        if (b >= windowStart && b < windowEnd) bump(key, 1);
        if (e !== null && e >= windowStart && e < windowEnd) bump(key, -1);
      }
    }

    const groups = new Map<
      string,
      {
        kind: 'facility' | 'unitType';
        id: string;
        name: string;
        total: number;
        out: number;
        occupied: number;
      }
    >();
    for (const u of data.units) {
      for (const [kind, id, name] of [
        ['facility', u.facilityId, u.facility.name],
        ['unitType', u.unitTypeId, u.unitType.name],
      ] as const) {
        const key = `${kind === 'facility' ? 'f' : 't'}:${id}`;
        const g = groups.get(key) ?? { kind, id, name, total: 0, out: 0, occupied: 0 };
        g.total += 1;
        if (u.status === 'maintenance' || u.status === 'blocked') g.out += 1;
        if (u.status === 'occupied') g.occupied += 1;
        groups.set(key, g);
      }
    }
    // El inquilino de prueba no ocupa (como en el resto de cifras).
    for (const [facilityId, counts] of data.counts.byFacility) {
      const g = groups.get(`f:${facilityId}`);
      if (g) g.occupied = counts.occupied ?? 0;
    }

    const segments: ForecastSegmentDto[] = [...groups.entries()].map(([key, g]) => {
      const cap = g.total - g.out;
      const perMonth = historyMonths > 0 ? (net.get(key) ?? 0) / historyMonths : 0;
      let fullBy: string | null = null;
      if (cap > 0 && g.occupied >= cap) fullBy = ym(year, month);
      else if (perMonth > 0 && cap > 0) {
        const months = Math.ceil((cap - g.occupied) / perMonth);
        if (months <= FULL_HORIZON_MONTHS) fullBy = ym(year, month + months);
      }
      return {
        kind: g.kind,
        id: g.id,
        name: g.name,
        capacity: cap,
        occupied: Math.min(g.occupied, Math.max(cap, 0)),
        netPerMonth: Math.round(perMonth * 10) / 10,
        fullBy,
      };
    });
    segments.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name, 'es') : a.kind === 'facility' ? -1 : 1,
    );

    return {
      scenarios: [
        project('low', Math.min(1, churn * 1.5), adds * 0.5),
        project('expected', churn, adds),
        project('high', churn * 0.5, adds * 1.5),
      ],
      segments,
      historyMonths,
    };
  }
}
