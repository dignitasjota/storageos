import { Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { AdminMetricsDto, AdminRetentionDto } from '@storageos/shared';

type TenantStatusKey = 'trial' | 'active' | 'suspended' | 'cancelled';

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

const round2 = (n: number): number => Math.round(n * 100) / 100;

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** Meses transcurridos de `a` a `b` (ambos primeros de mes UTC). */
function monthDiff(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

function monthLabel(d: Date): string {
  return `${MONTHS_ES[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
}

/**
 * Métricas globales del SaaS para el dashboard del super admin: estado de los
 * tenants, MRR real (cuotas mensuales de las suscripciones activas), ARPU,
 * crecimiento e ingresos por mes, distribución por plan, totales de plataforma
 * y un par de alertas operativas (trials que expiran, tickets abiertos).
 */
@Injectable()
export class AdminMetricsService {
  constructor(private readonly admin: PrismaAdminService) {}

  async getOverview(): Promise<AdminMetricsDto> {
    const now = new Date();
    const monthStart = startOfMonthUtc(now);

    // Ventana de 12 meses (UTC) para las series mensuales.
    const baseY = now.getUTCFullYear();
    const baseM = now.getUTCMonth();
    const months = Array.from({ length: 12 }, (_, idx) => {
      const d = new Date(Date.UTC(baseY, baseM - (11 - idx), 1));
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      return {
        key: `${year}-${String(month).padStart(2, '0')}`,
        label: `${MONTHS_ES[month - 1]} ${String(year % 100).padStart(2, '0')}`,
      };
    });
    const from12 = new Date(Date.UTC(baseY, baseM - 11, 1));
    const trialSoon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [
      statusGroups,
      signupsThisMonth,
      cancellationsThisMonth,
      totalAtMonthStart,
      subscriptions,
      trialsExpiringSoon,
      openSupportTickets,
      facilities,
      units,
      customers,
      contracts,
      users,
      signupRows,
      cancelRows,
      revenueRows,
    ] = await Promise.all([
      this.admin.tenant.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.admin.tenant.count({ where: { deletedAt: null, createdAt: { gte: monthStart } } }),
      this.admin.tenant.count({
        where: { deletedAt: null, status: 'cancelled', updatedAt: { gte: monthStart } },
      }),
      this.admin.tenant.count({ where: { deletedAt: null, createdAt: { lt: monthStart } } }),
      this.admin.tenantSubscription.findMany({
        where: { tenant: { deletedAt: null } },
        select: {
          status: true,
          plan: { select: { slug: true, name: true, priceMonthly: true } },
        },
      }),
      this.admin.tenant.count({
        where: { deletedAt: null, status: 'trial', trialEndsAt: { gte: now, lte: trialSoon } },
      }),
      this.admin.supportTicket.count({
        where: { status: { in: ['open', 'in_progress', 'waiting_user'] } },
      }),
      this.admin.facility.count({ where: { deletedAt: null } }),
      this.admin.unit.count(),
      this.admin.customer.count({ where: { deletedAt: null } }),
      this.admin.contract.count(),
      this.admin.user.count(),
      this.admin.tenant.findMany({
        where: { deletedAt: null, createdAt: { gte: from12 } },
        select: { createdAt: true },
      }),
      this.admin.tenant.findMany({
        where: { deletedAt: null, status: 'cancelled', updatedAt: { gte: from12 } },
        select: { updatedAt: true },
      }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: { status: 'paid', paidAt: { gte: from12 } },
        select: { paidAt: true, amount: true },
      }),
    ]);

    // --- Tenants por estado ---
    const tenants = { total: 0, trial: 0, active: 0, suspended: 0, cancelled: 0 };
    for (const row of statusGroups) {
      const key = row.status as TenantStatusKey;
      tenants[key] = row._count._all;
      tenants.total += row._count._all;
    }

    // --- MRR (cuotas de suscripciones activas) + distribución por plan ---
    const planMap = new Map<
      string,
      { planSlug: string; planName: string; count: number; mrr: number }
    >();
    let mrrTotal = 0;
    for (const s of subscriptions) {
      const slug = s.plan.slug;
      const entry = planMap.get(slug) ?? {
        planSlug: slug,
        planName: s.plan.name,
        count: 0,
        mrr: 0,
      };
      entry.count += 1;
      if (s.status === 'active') {
        const monthly = Number(s.plan.priceMonthly);
        entry.mrr += monthly;
        mrrTotal += monthly;
      }
      planMap.set(slug, entry);
    }
    const tenantsByPlan = [...planMap.values()]
      .map((p) => ({ ...p, mrr: round2(p.mrr) }))
      .sort((a, b) => b.count - a.count);

    // --- Series mensuales ---
    const signupsByKey = new Map<string, number>();
    for (const r of signupRows) {
      const k = monthKey(r.createdAt);
      signupsByKey.set(k, (signupsByKey.get(k) ?? 0) + 1);
    }
    const cancelsByKey = new Map<string, number>();
    for (const r of cancelRows) {
      const k = monthKey(r.updatedAt);
      cancelsByKey.set(k, (cancelsByKey.get(k) ?? 0) + 1);
    }
    const revenueByKey = new Map<string, number>();
    for (const r of revenueRows) {
      if (!r.paidAt) continue;
      const k = monthKey(r.paidAt);
      revenueByKey.set(k, (revenueByKey.get(k) ?? 0) + Number(r.amount));
    }

    const churnRatePercent =
      totalAtMonthStart > 0 ? (cancellationsThisMonth / totalAtMonthStart) * 100 : 0;

    return {
      tenants,
      mrr: { total: round2(mrrTotal), currency: 'EUR' },
      signupsThisMonth,
      cancellationsThisMonth,
      churnRatePercent: round2(churnRatePercent),
      averageRevenuePerTenant: tenants.active > 0 ? round2(mrrTotal / tenants.active) : 0,
      trialsExpiringSoon,
      openSupportTickets,
      platform: { facilities, units, customers, contracts, users },
      tenantsByPlan,
      monthlyGrowth: months.map((m) => ({
        label: m.label,
        signups: signupsByKey.get(m.key) ?? 0,
        cancellations: cancelsByKey.get(m.key) ?? 0,
      })),
      monthlySaasRevenue: months.map((m) => ({
        label: m.label,
        collected: round2(revenueByKey.get(m.key) ?? 0),
      })),
    };
  }

  /**
   * Matriz de cohortes de retención: agrupa los tenants por su mes de alta y,
   * para cada offset de mes, calcula el % que seguía vivo. "Vivo" = no
   * `cancelled`/`suspended`; la fecha de baja se aproxima por `updatedAt` (igual
   * criterio que el resto de métricas). M0 es 100% por construcción.
   */
  async getRetention(months: number): Promise<AdminRetentionDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const nowMonth = startOfMonthUtc(new Date());
    const firstCohort = addMonthsUtc(nowMonth, -(span - 1));

    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, createdAt: { gte: firstCohort } },
      select: { createdAt: true, status: true, updatedAt: true },
    });

    // Por tenant: mes de alta + mes de baja (null si sigue vivo).
    const records = tenants.map((t) => {
      const cohortMonth = startOfMonthUtc(t.createdAt);
      const churned = t.status === 'cancelled' || t.status === 'suspended';
      return { cohortMonth, churnMonth: churned ? startOfMonthUtc(t.updatedAt) : null };
    });

    const maxOffset = monthDiff(firstCohort, nowMonth);
    const cohorts = [];
    for (let i = 0; i < span; i++) {
      const c = addMonthsUtc(firstCohort, i);
      const members = records.filter((r) => r.cohortMonth.getTime() === c.getTime());
      const size = members.length;
      const maxK = monthDiff(c, nowMonth); // offsets con datos para esta cohorte
      const retention: (number | null)[] = [];
      for (let k = 0; k <= maxOffset; k++) {
        if (k > maxK) {
          retention.push(null);
          continue;
        }
        if (size === 0) {
          retention.push(0);
          continue;
        }
        const target = addMonthsUtc(c, k);
        const alive = members.filter(
          (r) => r.churnMonth === null || r.churnMonth.getTime() >= target.getTime(),
        ).length;
        retention.push(round2((alive / size) * 100));
      }
      cohorts.push({ cohort: monthLabel(c), size, retention });
    }

    return { maxOffset, cohorts };
  }
}
