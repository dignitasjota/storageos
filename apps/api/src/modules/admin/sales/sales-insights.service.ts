import { Injectable } from '@nestjs/common';
import {
  forecastRevenueCommission,
  salesMonth,
  type SalesForecastDto,
  type SalesTeamComparisonDto,
  type SalesTeamComparisonRowDto,
  type SalesTeamForecastDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SalesCommissionsService } from './sales-commissions.service';
import { addMonths, DAY, monthOf, monthRange, round2 } from './sales-common';

const FORECAST_MONTHS = 6;

/** Los próximos N meses (AAAA-MM), empezando por el siguiente al actual. */
function nextMonths(now: Date, n: number): string[] {
  const out: string[] = [];
  const base = new Date(`${salesMonth(now)}-15T12:00:00Z`);
  for (let i = 1; i <= n; i++) out.push(salesMonth(addMonths(base, i)));
  return out;
}

/** Los últimos N meses (AAAA-MM), terminando en el actual. */
function lastMonths(now: Date, n: number): string[] {
  const out: string[] = [];
  const base = new Date(`${salesMonth(now)}-15T12:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(salesMonth(addMonths(base, -i)));
  return out;
}

/**
 * Previsión de comisiones (con la cartera de hoy) y comparativa del equipo.
 * Solo lectura.
 */
@Injectable()
export class SalesInsightsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly commissions: SalesCommissionsService,
  ) {}

  /**
   * Clientes de pago de cada comercial con lo que aportan al mes sin IVA (plan
   * y extras que cuentan para su comisión) y el mes de su primer pago.
   */
  private async payingClients(
    repIds: string[],
  ): Promise<Map<string, { monthlyNet: number; firstPaidMonth: string }[]>> {
    const out = new Map<string, { monthlyNet: number; firstPaidMonth: string }[]>();
    if (repIds.length === 0) return out;
    const tenants = await this.admin.tenant.findMany({
      where: {
        salesRepId: { in: repIds },
        deletedAt: null,
        status: 'active',
        billingExempt: false,
        subscription: { status: { in: ['active', 'past_due'] } },
      },
      select: {
        id: true,
        salesRepId: true,
        subscription: { select: { plan: { select: { priceMonthly: true } } } },
        subscriptionAddons: {
          where: { suspendedAt: null },
          select: { addonId: true, priceMonthly: true, quantity: true },
        },
      },
    });
    if (tenants.length === 0) return out;
    const ids = tenants.map((t) => t.id);
    const [firstPaid, claims, settings] = await Promise.all([
      this.commissions.firstPaidByTenant(ids),
      this.admin.salesAddonClaim.findMany({
        where: { tenantId: { in: ids }, status: 'approved' },
        select: { tenantId: true, addonId: true },
      }),
      this.admin.platformBillingSettings.findFirst({
        select: { taxRate: true, pricesIncludeVat: true },
      }),
    ]);
    const vat =
      settings?.pricesIncludeVat === false ? 1 : 1 + Number(settings?.taxRate ?? 21) / 100;
    const counted = new Set(claims.map((c) => `${c.tenantId}:${c.addonId}`));
    for (const t of tenants) {
      const paid = firstPaid.get(t.id);
      if (!paid || !t.salesRepId) continue;
      const addons = t.subscriptionAddons
        .filter((a) => counted.has(`${t.id}:${a.addonId}`))
        .reduce((s, a) => s + Number(a.priceMonthly) * a.quantity, 0);
      const gross = Number(t.subscription?.plan.priceMonthly ?? 0) + addons;
      const list = out.get(t.salesRepId) ?? [];
      list.push({ monthlyNet: round2(gross / vat), firstPaidMonth: monthOf(paid) });
      out.set(t.salesRepId, list);
    }
    return out;
  }

  /** Lo que cobrará el comercial por el % de sus clientes los próximos meses. */
  async forecast(repId: string, now = new Date()): Promise<SalesForecastDto> {
    const [plan, clients] = await Promise.all([
      this.admin.salesCommissionPlan.findUnique({ where: { repId } }),
      this.payingClients([repId]),
    ]);
    const months = nextMonths(now, FORECAST_MONTHS);
    const mine = clients.get(repId) ?? [];
    const revenuePct = Number(plan?.revenuePct ?? 0);
    const amounts = forecastRevenueCommission({
      clients: mine,
      revenuePct,
      revenueMonths: plan?.revenueMonths ?? null,
      months,
    });
    return {
      months: months.map((month, i) => ({ month, amount: amounts[i] ?? 0 })),
      total: round2(amounts.reduce((s, a) => s + a, 0)),
      clients: mine.length,
      revenuePct,
    };
  }

  /** La previsión de todo el equipo (lo que costarán las comisiones). */
  async teamForecast(now = new Date()): Promise<SalesTeamForecastDto> {
    const reps = await this.admin.superAdmin.findMany({
      where: { role: 'sales', isActive: true },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true },
    });
    const months = nextMonths(now, FORECAST_MONTHS);
    const [plans, clients] = await Promise.all([
      this.admin.salesCommissionPlan.findMany({
        where: { repId: { in: reps.map((r) => r.id) } },
      }),
      this.payingClients(reps.map((r) => r.id)),
    ]);
    const planOf = new Map(plans.map((p) => [p.repId, p]));
    const rows = reps.map((r) => {
      const plan = planOf.get(r.id);
      const amounts = forecastRevenueCommission({
        clients: clients.get(r.id) ?? [],
        revenuePct: Number(plan?.revenuePct ?? 0),
        revenueMonths: plan?.revenueMonths ?? null,
        months,
      });
      return {
        repId: r.id,
        repName: r.fullName,
        amounts,
        total: round2(amounts.reduce((s, a) => s + a, 0)),
      };
    });
    const totals = months.map((_, i) => round2(rows.reduce((s, r) => s + (r.amounts[i] ?? 0), 0)));
    return { months, reps: rows, totals, total: round2(totals.reduce((s, a) => s + a, 0)) };
  }

  /** Comparativa del equipo en los últimos `months` meses (incluido el actual). */
  async comparison(monthsRaw: number, now = new Date()): Promise<SalesTeamComparisonDto> {
    const months = Math.min(12, Math.max(1, Math.floor(monthsRaw) || 3));
    const list = lastMonths(now, months);
    const from = monthRange(list[0]!).from;
    const reps = await this.admin.superAdmin.findMany({
      where: { role: 'sales' },
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      select: { id: true, fullName: true, isActive: true },
    });
    const ids = reps.map((r) => r.id);
    // Asegura las ventas de cada mes del periodo.
    for (const m of list) await this.commissions.monthAchievements(m);
    const [assignments, trials, wins, churned, commissions, paying] = await Promise.all([
      this.admin.salesAssignment.findMany({
        where: { repId: { in: ids }, leadId: { not: null }, startedAt: { gte: from } },
        select: { repId: true, leadId: true },
      }),
      this.admin.tenant.groupBy({
        by: ['salesRepId'],
        where: { salesRepId: { in: ids }, createdAt: { gte: from }, deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.salesWin.findMany({
        where: { repId: { in: ids }, month: { in: list } },
        select: {
          repId: true,
          paidAt: true,
          tenant: { select: { createdAt: true } },
        },
      }),
      this.admin.tenant.groupBy({
        by: ['salesRepId'],
        where: {
          salesRepId: { in: ids },
          status: { in: ['suspended', 'cancelled'] },
          canceledAt: { gte: from },
        },
        _count: { _all: true },
      }),
      this.admin.salesCommissionItem.groupBy({
        by: ['repId'],
        where: { repId: { in: ids }, status: 'approved', month: { in: list } },
        _sum: { amount: true },
      }),
      this.admin.tenant.findMany({
        where: {
          salesRepId: { in: ids },
          deletedAt: null,
          status: 'active',
          subscription: { status: { in: ['active', 'past_due'] } },
        },
        select: { id: true, salesRepId: true },
      }),
    ]);
    const firstPaid = await this.commissions.firstPaidByTenant(paying.map((t) => t.id));
    const monthly = await this.commissions.monthlyByTenant(
      paying.filter((t) => firstPaid.has(t.id)).map((t) => t.id),
    );
    const rows: SalesTeamComparisonRowDto[] = reps.map((r) => {
      const leads = new Set(assignments.filter((a) => a.repId === r.id).map((a) => a.leadId)).size;
      const t = trials.find((x) => x.salesRepId === r.id)?._count._all ?? 0;
      const mine = wins.filter((w) => w.repId === r.id);
      const days = mine.map((w) => (w.paidAt.getTime() - w.tenant.createdAt.getTime()) / DAY);
      const mrr = paying
        .filter((p) => p.salesRepId === r.id)
        .reduce((s, p) => s + (monthly.get(p.id) ?? 0), 0);
      return {
        repId: r.id,
        repName: r.fullName,
        isActive: r.isActive,
        leads,
        trials: t,
        wins: mine.length,
        conversionPct: t > 0 ? Math.round((mine.length / t) * 100) : null,
        avgDaysToClose: days.length
          ? Math.round(days.reduce((s, d) => s + Math.max(0, d), 0) / days.length)
          : null,
        churned: churned.find((x) => x.salesRepId === r.id)?._count._all ?? 0,
        mrr: round2(mrr),
        commission: round2(Number(commissions.find((c) => c.repId === r.id)?._sum.amount ?? 0)),
      };
    });
    return {
      months,
      from: list[0]!,
      to: list[list.length - 1]!,
      rows,
    };
  }
}
