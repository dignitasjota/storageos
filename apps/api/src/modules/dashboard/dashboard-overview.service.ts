import { Injectable, Logger } from '@nestjs/common';
import { dashboardPeriodRange, resolveDashboardLayout } from '@storageos/shared';

import { todayInTimezone, zonedDayStart } from '../../common/format';
import { CONFIRMED_START_WHERE } from '../../common/pre-opening';
import {
  contractWhere,
  leadWhere,
  liveMrr,
  LIVE_CONTRACT_WHERE,
  REAL_CONTRACT_WHERE,
  resolveAnalyticsScope,
  unitWhere,
  type AnalyticsScope,
} from '../analytics/analytics-scope';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  collectedBetween,
  contractMoveRows,
  contractMoves,
  INVOICED_SELECT,
  invoicedBase,
  invoicedBetween,
  invoicedWhere,
  newCustomers,
  receivables,
  tenantTimezone,
  unitCounts,
  type ContractMoveRow,
} from '../analytics/business-metrics';
import { InsightsService } from '../analytics/insights.service';
import { PrismaService } from '../database/prisma.service';

import { TodaySummaryService } from './today-summary.service';

import type { Prisma } from '@storageos/database';
import type {
  DashboardCashDto,
  DashboardCommercialDto,
  DashboardFacilityRowDto,
  DashboardLayout,
  DashboardMoveDto,
  DashboardMovesDto,
  DashboardOverviewDto,
  DashboardPeriod,
  DashboardPeriodFiguresDto,
  DashboardPeriodRange,
  DashboardPeriodValuesDto,
  DashboardResultDto,
  DashboardVacancyDto,
  Permission,
} from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 86_400_000;
const LIST_LIMIT = 8;
const UPCOMING_DAYS = 30;

type MoveCustomer = ContractMoveRow['customer'];
const nameOf = (c: MoveCustomer) =>
  c.customerType === 'business'
    ? (c.companyName ?? '—')
    : [c.firstName, c.lastName].filter(Boolean).join(' ') || '—';
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Cifras del Resumen: una petición, con cada sección independiente de las demás. */
@Injectable()
export class DashboardOverviewService {
  private readonly logger = new Logger(DashboardOverviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly insights: InsightsService,
    private readonly summary: TodaySummaryService,
  ) {}

  async overview(
    tenantId: string,
    facilityId: string | undefined,
    userScope: string[] | null,
    permissions: readonly Permission[],
    period: DashboardPeriod = 'month',
  ): Promise<DashboardOverviewDto> {
    const scope = resolveAnalyticsScope(userScope, facilityId);
    const clock = await this.prisma.withTenant(async (tx) => {
      const timezone = await tenantTimezone(tx, tenantId);
      const startOfToday = todayInTimezone(timezone);
      return {
        timezone,
        startOfToday,
        range: dashboardPeriodRange(period, day(startOfToday)),
      };
    }, tenantId);
    const { timezone, startOfToday, range } = clock;
    const moneyVisible =
      permissions.includes('invoices:read') && permissions.includes('payments:read');
    const inTx = <T>(load: (tx: Prisma.TransactionClient) => Promise<T>) =>
      this.prisma.withTenant(load, tenantId);
    const section = async <T>(name: string, load: () => Promise<T>): Promise<T | null> => {
      try {
        return await load();
      } catch (err) {
        this.logger.error(`Resumen: falló «${name}» del tenant ${tenantId}: ${String(err)}`);
        return null;
      }
    };

    const [
      month,
      figures,
      cash,
      vacancy,
      moves,
      byFacility,
      result,
      commercial,
      revenue,
      occupancy,
      customers,
      debt,
      monthlyRevenue,
      forecast,
      churnRisk,
      leads,
    ] = await Promise.all([
      section('month', () => this.summary.kpis(tenantId, facilityId, userScope, permissions)),
      section('period', () =>
        inTx((tx) => this.periodFigures(tx, scope, period, range, timezone, moneyVisible)),
      ),
      section('cash', () => inTx((tx) => this.cash(tx, scope, startOfToday, timezone))),
      section('vacancy', () => inTx((tx) => this.vacancy(tx, scope, startOfToday))),
      section('moves', () =>
        permissions.includes('contracts:read')
          ? inTx((tx) => this.moves(tx, scope, range, timezone, startOfToday))
          : Promise.resolve(null),
      ),
      section('byFacility', () =>
        inTx((tx) => this.facilityRows(tx, scope, range, timezone, startOfToday, moneyVisible)),
      ),
      section('result', () =>
        permissions.includes('expenses:read')
          ? inTx((tx) => this.result(tx, scope, range))
          : Promise.resolve(null),
      ),
      section('commercial', () => inTx((tx) => this.commercial(tx, tenantId, scope))),
      section('revenue', () => this.analytics.getRevenue(tenantId, scope)),
      section('occupancy', () => this.analytics.getOccupancy(tenantId, scope)),
      section('customers', () => this.analytics.getCustomerStats(tenantId, scope)),
      section('receivables', () =>
        this.prisma.withTenant(
          async (tx) => receivables(tx, scope, todayInTimezone(await tenantTimezone(tx, tenantId))),
          tenantId,
        ),
      ),
      section('monthlyRevenue', () =>
        this.analytics.getMonthlyRevenue(tenantId, { months: 12 }, scope),
      ),
      section('forecast', () => this.insights.getRevenueForecast(tenantId, { months: 6 }, scope)),
      section('churnRisk', () => this.insights.getChurnRisk(tenantId, scope)),
      section('leads', () => this.analytics.getLeadsFunnel(tenantId, undefined, scope)),
    ]);

    return {
      month,
      period: figures,
      cash,
      vacancy,
      moves,
      byFacility,
      result,
      commercial,
      revenue,
      occupancy,
      customers,
      receivables: debt,
      monthlyRevenue,
      forecast,
      churnRisk,
      leads,
    };
  }

  private async periodValues(
    tx: Prisma.TransactionClient,
    scope: AnalyticsScope,
    from: string,
    to: string,
    timezone: string,
    moneyVisible: boolean,
  ): Promise<DashboardPeriodValuesDto> {
    const start = zonedDayStart(from, timezone);
    const end = zonedDayStart(to, timezone);
    const [invoiced, collected, moves, customers] = await Promise.all([
      invoicedBetween(tx, scope, new Date(from), new Date(to)),
      collectedBetween(tx, scope, start, end),
      contractMoves(tx, scope, start, end),
      newCustomers(tx, scope, start, end),
    ]);
    return {
      invoiced: moneyVisible ? invoiced : 0,
      collected: moneyVisible ? collected : 0,
      moveIns: moves.moveIns,
      moveOuts: moves.moveOuts,
      newCustomers: customers,
    };
  }

  private async periodFigures(
    tx: Prisma.TransactionClient,
    scope: AnalyticsScope,
    period: DashboardPeriod,
    range: DashboardPeriodRange,
    timezone: string,
    moneyVisible: boolean,
  ): Promise<DashboardPeriodFiguresDto> {
    const [current, previous] = await Promise.all([
      this.periodValues(tx, scope, range.from, range.to, timezone, moneyVisible),
      this.periodValues(tx, scope, range.previousFrom, range.previousTo, timezone, moneyVisible),
    ]);
    return { ...current, period, moneyVisible, previous };
  }

  /** Caja del mes en curso, sea cual sea el periodo elegido. */
  private async cash(
    tx: Prisma.TransactionClient,
    scope: AnalyticsScope,
    startOfToday: Date,
    timezone: string,
  ): Promise<DashboardCashDto> {
    const y = startOfToday.getUTCFullYear();
    const m = startOfToday.getUTCMonth();
    const monthStart = day(new Date(Date.UTC(y, m, 1)));
    const nextMonth = new Date(Date.UTC(y, m + 1, 1));
    const [debt, collected, dueRows] = await Promise.all([
      receivables(tx, scope, startOfToday),
      collectedBetween(
        tx,
        scope,
        zonedDayStart(monthStart, timezone),
        zonedDayStart(day(nextMonth), timezone),
      ),
      receivables(tx, scope, nextMonth),
    ]);
    const dueThisMonth = round2(dueRows.overdue - debt.overdue);
    return {
      collected,
      overdue: debt.overdue,
      dueThisMonth,
      dueLater: round2(debt.notDue - dueThisMonth),
      projected: round2(collected + dueThisMonth),
    };
  }

  private async vacancy(
    tx: Prisma.TransactionClient,
    scope: AnalyticsScope,
    startOfToday: Date,
  ): Promise<DashboardVacancyDto> {
    const units = await tx.unit.findMany({
      where: { ...unitWhere(scope), status: 'available' },
      select: {
        id: true,
        code: true,
        createdAt: true,
        basePriceMonthly: true,
        unitTypeId: true,
        unitType: { select: { name: true } },
        facility: { select: { name: true } },
      },
    });
    const history = await tx.unitStatusHistory.groupBy({
      by: ['unitId'],
      where: { unitId: { in: units.map((u) => u.id) }, newStatus: 'available' },
      _max: { occurredAt: true },
    });
    const freeSince = new Map(history.map((h) => [h.unitId, h._max.occurredAt]));
    const rows = units.map((u) => {
      const since = freeSince.get(u.id) ?? u.createdAt;
      return {
        ...u,
        price: Number(u.basePriceMonthly),
        days: Math.max(0, Math.floor((startOfToday.getTime() - since.getTime()) / DAY_MS)),
      };
    });

    const types = new Map<string, DashboardVacancyDto['byType'][number] & { daysSum: number }>();
    for (const r of rows) {
      const t = types.get(r.unitTypeId) ?? {
        unitTypeId: r.unitTypeId,
        name: r.unitType.name,
        free: 0,
        monthlyValue: 0,
        avgDaysFree: 0,
        daysSum: 0,
      };
      t.free += 1;
      t.monthlyValue += r.price;
      t.daysSum += r.days;
      types.set(r.unitTypeId, t);
    }
    return {
      freeUnits: rows.length,
      monthlyValue: round2(rows.reduce((sum, r) => sum + r.price, 0)),
      byType: [...types.values()]
        .map(({ daysSum, ...t }) => ({
          ...t,
          monthlyValue: round2(t.monthlyValue),
          avgDaysFree: Math.round(daysSum / t.free),
        }))
        .sort((a, b) => b.monthlyValue - a.monthlyValue),
      longestFree: [...rows]
        .sort((a, b) => b.days - a.days)
        .slice(0, 5)
        .map((r) => ({ unitId: r.id, code: r.code, facilityName: r.facility.name, days: r.days })),
    };
  }

  private async moves(
    tx: Prisma.TransactionClient,
    scope: AnalyticsScope,
    range: DashboardPeriodRange,
    timezone: string,
    startOfToday: Date,
  ): Promise<DashboardMovesDto> {
    const toDto = (r: ContractMoveRow): DashboardMoveDto => ({
      contractId: r.id,
      customerName: nameOf(r.customer),
      unitCode: r.unitCode,
      date: day(todayInTimezone(timezone, r.date)),
    });
    const newest = (rows: ContractMoveRow[]) =>
      [...rows]
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, LIST_LIMIT)
        .map(toDto);

    const until = new Date(startOfToday.getTime() + (UPCOMING_DAYS + 1) * DAY_MS);
    const select = {
      id: true,
      startDate: true,
      endDate: true,
      unit: { select: { code: true } },
      customer: {
        select: { customerType: true, firstName: true, lastName: true, companyName: true },
      },
    } as const;
    const inScope = contractWhere(scope);
    const [done, entering, leaving, expiring] = await Promise.all([
      contractMoveRows(
        tx,
        scope,
        zonedDayStart(range.from, timezone),
        zonedDayStart(range.to, timezone),
      ),
      tx.contract.findMany({
        where: {
          AND: [
            REAL_CONTRACT_WHERE,
            CONFIRMED_START_WHERE,
            inScope,
            {
              status: 'active',
              deletedAt: null,
              signedAt: { not: null },
              startDate: { gt: startOfToday, lt: until },
            },
          ],
        },
        select,
        orderBy: { startDate: 'asc' },
        take: LIST_LIMIT,
      }),
      tx.contract.findMany({
        where: {
          AND: [
            LIVE_CONTRACT_WHERE,
            inScope,
            { status: 'ending', endDate: { gte: startOfToday, lt: until } },
          ],
        },
        select,
        orderBy: { endDate: 'asc' },
        take: LIST_LIMIT,
      }),
      tx.contract.findMany({
        where: {
          AND: [
            LIVE_CONTRACT_WHERE,
            inScope,
            { status: 'active', autoRenew: false, endDate: { gte: startOfToday, lt: until } },
          ],
        },
        select,
        orderBy: { endDate: 'asc' },
        take: LIST_LIMIT,
      }),
    ]);
    const planned = (c: (typeof entering)[number], date: Date | null): DashboardMoveDto => ({
      contractId: c.id,
      customerName: nameOf(c.customer),
      unitCode: c.unit.code,
      date: date ? day(date) : '',
    });
    return {
      moveIns: newest(done.moveIns),
      moveOuts: newest(done.moveOuts),
      upcomingMoveIns: entering.map((c) => planned(c, c.startDate)),
      upcomingMoveOuts: leaving.map((c) => planned(c, c.endDate)),
      expiring: expiring.map((c) => planned(c, c.endDate)),
    };
  }

  private async facilityRows(
    tx: Prisma.TransactionClient,
    scope: AnalyticsScope,
    range: DashboardPeriodRange,
    timezone: string,
    startOfToday: Date,
    moneyVisible: boolean,
  ): Promise<DashboardFacilityRowDto[]> {
    const facilities = await tx.facility.findMany({
      where: { deletedAt: null, ...(scope.ids ? { id: { in: scope.ids } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const from = zonedDayStart(range.from, timezone);
    const to = zonedDayStart(range.to, timezone);
    return Promise.all(
      facilities.map(async (f) => {
        const one: AnalyticsScope = { ids: [f.id], explicit: true };
        const [units, live, debt, moves] = await Promise.all([
          unitCounts(tx, one),
          liveMrr(tx, one),
          receivables(tx, one, startOfToday),
          contractMoves(tx, one, from, to),
        ]);
        return {
          facilityId: f.id,
          name: f.name,
          totalUnits: units.total,
          occupiedUnits: units.occupied,
          occupancyPct: units.total ? Math.round((units.occupied / units.total) * 1000) / 10 : 0,
          mrr: moneyVisible ? live.mrr : null,
          overdue: moneyVisible ? debt.overdue : null,
          moveIns: moves.moveIns,
          moveOuts: moves.moveOuts,
        };
      }),
    );
  }

  /** Lo facturado sin IVA menos los gastos del periodo. */
  private async result(
    tx: Prisma.TransactionClient,
    scope: AnalyticsScope,
    range: DashboardPeriodRange,
  ): Promise<DashboardResultDto> {
    const net = async (from: string, to: string) => {
      const [invoices, expenses] = await Promise.all([
        tx.invoice.findMany({
          where: invoicedWhere(scope, new Date(from), new Date(to)),
          select: INVOICED_SELECT,
        }),
        tx.expense.aggregate({
          where: {
            expenseDate: { gte: new Date(from), lt: new Date(to) },
            // Sin local elegido entran también los gastos generales.
            ...(scope.explicit
              ? { facilityId: { in: scope.ids ?? [] } }
              : scope.ids
                ? { OR: [{ facilityId: { in: scope.ids } }, { facilityId: null }] }
                : {}),
          },
          _sum: { amount: true },
        }),
      ]);
      const income = round2(invoices.reduce((sum, r) => sum + invoicedBase(r), 0));
      const spent = round2(Number(expenses._sum.amount ?? 0));
      return { income, expenses: spent, net: round2(income - spent) };
    };
    const [current, previous] = await Promise.all([
      net(range.from, range.to),
      net(range.previousFrom, range.previousTo),
    ]);
    return { ...current, previousNet: previous.net };
  }

  private async commercial(
    tx: Prisma.TransactionClient,
    tenantId: string,
    scope: AnalyticsScope,
  ): Promise<DashboardCommercialDto> {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { leadResponseHours: true },
    });
    const responseHours = tenant?.leadResponseHours ?? 4;
    const now = new Date();
    const leads = { deletedAt: null, ...leadWhere(scope) };
    const inScope = contractWhere(scope);
    const [unattendedLeads, openLeads, pendingSignature, pendingPayment, waitlist] =
      await Promise.all([
        tx.lead.count({
          where: {
            ...leads,
            status: 'new',
            contactedAt: null,
            createdAt: { lte: new Date(now.getTime() - responseHours * 3_600_000) },
          },
        }),
        tx.lead.count({ where: { ...leads, status: { in: ['new', 'contacted', 'qualified'] } } }),
        tx.contract.count({
          where: {
            AND: [
              REAL_CONTRACT_WHERE,
              inScope,
              { status: 'draft', deletedAt: null, signingTokenExpiresAt: { gte: now } },
            ],
          },
        }),
        tx.contract.count({
          where: {
            AND: [
              REAL_CONTRACT_WHERE,
              inScope,
              {
                status: 'active',
                deletedAt: null,
                firstPaymentDeadline: { not: null },
                invoices: { none: { status: 'paid', kind: 'invoice' } },
              },
            ],
          },
        }),
        tx.waitlistEntry.count({
          where: {
            status: 'waiting',
            ...(scope.ids ? { facilityId: { in: scope.ids } } : {}),
          },
        }),
      ]);
    return { unattendedLeads, openLeads, pendingSignature, pendingPayment, waitlist };
  }

  async getLayout(tenantId: string, userId: string): Promise<DashboardLayout> {
    const user = await this.prisma.withTenant(
      (tx) => tx.user.findFirst({ where: { id: userId }, select: { dashboardLayout: true } }),
      tenantId,
    );
    return resolveDashboardLayout(user?.dashboardLayout);
  }

  async setLayout(
    tenantId: string,
    userId: string,
    layout: DashboardLayout,
  ): Promise<DashboardLayout> {
    await this.prisma.withTenant(
      (tx) => tx.user.update({ where: { id: userId }, data: { dashboardLayout: layout } }),
      tenantId,
    );
    return resolveDashboardLayout(layout);
  }
}
