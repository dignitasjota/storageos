import { Injectable } from '@nestjs/common';

import { SaasAddonsService } from '../billing-saas/saas-addons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminChurnByReasonDto,
  AdminLtvDto,
  AdminMetricsDto,
  AdminPaymentRetryAnalysisDto,
  AdminRetentionDto,
} from '@storageos/shared';

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
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly addons: SaasAddonsService,
  ) {}

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
      // Las cuentas EXENTAS (billingExempt) quedan fuera de toda métrica de
      // negocio: no cuentan al MRR/ARPU/ingresos, ni a estados/crecimiento/trials.
      this.admin.tenant.groupBy({
        by: ['status'],
        where: { deletedAt: null, billingExempt: false },
        _count: { _all: true },
      }),
      this.admin.tenant.count({
        where: { deletedAt: null, billingExempt: false, createdAt: { gte: monthStart } },
      }),
      this.admin.tenant.count({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: 'cancelled',
          updatedAt: { gte: monthStart },
        },
      }),
      this.admin.tenant.count({
        where: { deletedAt: null, billingExempt: false, createdAt: { lt: monthStart } },
      }),
      this.admin.tenantSubscription.findMany({
        where: { tenant: { deletedAt: null, billingExempt: false } },
        select: {
          tenantId: true,
          status: true,
          plan: { select: { slug: true, name: true, priceMonthly: true } },
        },
      }),
      this.admin.tenant.count({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: 'trial',
          trialEndsAt: { gte: now, lte: trialSoon },
        },
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
        where: { deletedAt: null, billingExempt: false, createdAt: { gte: from12 } },
        select: { createdAt: true },
      }),
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: 'cancelled',
          updatedAt: { gte: from12 },
        },
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
    // Add-ons facturables: se suman al MRR total y al ARPU (no a la distribución
    // por plan, porque no pertenecen a ningún plan).
    const addonsByTenant = await this.addons.addonsMonthlyByTenant();
    let addonsMrr = 0;
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
        addonsMrr += addonsByTenant.get(s.tenantId) ?? 0;
      }
      planMap.set(slug, entry);
    }
    mrrTotal += addonsMrr;
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
      where: { deletedAt: null, billingExempt: false, createdAt: { gte: firstCohort } },
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

  /**
   * Churn de tenants agrupado por motivo en la ventana de N meses. El motivo es
   * el `churnReason` CAPTURADO al suspender/cancelar; si falta (bajas antiguas o
   * automáticas), se INFIERE: `nonpayment` si la suscripción quedó `past_due`,
   * `voluntary` si estaba marcada para cancelar a fin de periodo, `unknown` si
   * no. `lostMrr` = Σ del precio mensual del plan de esos tenants.
   */
  async getChurnByReason(months: number): Promise<AdminChurnByReasonDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const windowStart = addMonthsUtc(startOfMonthUtc(new Date()), -(span - 1));

    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        billingExempt: false,
        status: { in: ['suspended', 'cancelled'] },
        // `canceledAt` es fiable; para bajas anteriores a la columna cae a
        // `updatedAt` (mismo proxy que el resto de métricas).
        OR: [
          { canceledAt: { gte: windowStart } },
          { canceledAt: null, updatedAt: { gte: windowStart } },
        ],
      },
      select: {
        churnReason: true,
        subscription: {
          select: {
            status: true,
            cancelAtPeriodEnd: true,
            plan: { select: { priceMonthly: true } },
          },
        },
      },
    });

    const acc = new Map<string, { count: number; lostMrr: number; captured: number }>();
    let totalChurned = 0;
    let lostMrr = 0;
    for (const t of tenants) {
      const captured = Boolean(t.churnReason);
      let reason = t.churnReason;
      if (!reason) {
        if (t.subscription?.status === 'past_due') reason = 'nonpayment';
        else if (t.subscription?.cancelAtPeriodEnd) reason = 'voluntary';
        else reason = 'unknown';
      }
      const mrr = t.subscription?.plan ? Number(t.subscription.plan.priceMonthly) : 0;
      const slice = acc.get(reason) ?? { count: 0, lostMrr: 0, captured: 0 };
      slice.count += 1;
      slice.lostMrr += mrr;
      if (captured) slice.captured += 1;
      acc.set(reason, slice);
      totalChurned += 1;
      lostMrr += mrr;
    }

    const slices = [...acc.entries()]
      .map(([reason, s]) => ({
        reason,
        count: s.count,
        lostMrr: round2(s.lostMrr),
        captured: s.captured,
      }))
      .sort((a, b) => b.count - a.count);

    return { months: span, totalChurned, lostMrr: round2(lostMrr), slices };
  }

  /**
   * LTV (valor de vida del cliente) + cohortes de ingresos del SaaS.
   *
   * Fórmula (pragmática, basada en los pagos `paid` de suscripción):
   *  - Por cada tenant pagador (≥1 pago): `totalPaid` (Σ pagos), `lifespanMonths`
   *    = meses entre el alta y su baja (aprox. por `updatedAt` de suspended/
   *    cancelled, mismo criterio que `getRetention`) o hasta hoy si sigue vivo,
   *    con mínimo 1; `arpa_i` = `totalPaid / lifespanMonths`.
   *  - `avgArpa` = media de `arpa_i`; `avgLifespanMonths` = media de `lifespan_i`.
   *  - `avgLtv` (modelo) = `avgArpa × avgLifespanMonths` (estimación prospectiva).
   *  - `realizedLtv` = Σ `totalPaid` / nº pagadores (valor ya cobrado por cuenta).
   *
   * Cohortes de ingresos: por mes de alta (`createdAt`, últimos N meses), el
   * ingreso ACUMULADO (Σ pagos de esos tenants) y el nº de tenants de la cohorte.
   */
  async getLtv(months: number): Promise<AdminLtvDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const nowMonth = startOfMonthUtc(new Date());
    const firstCohort = addMonthsUtc(nowMonth, -(span - 1));

    // Agregado por tenant de sus pagos `paid` (una sola agregación en BD).
    const payGroups = await this.admin.tenantSubscriptionPayment.groupBy({
      by: ['tenantId'],
      where: { status: 'paid' },
      _sum: { amount: true },
      _count: { _all: true },
      _min: { paidAt: true },
    });

    const totalByTenant = new Map<string, number>();
    const countByTenant = new Map<string, number>();
    const firstPaidByTenant = new Map<string, Date | null>();
    for (const g of payGroups) {
      totalByTenant.set(g.tenantId, Number(g._sum.amount ?? 0));
      countByTenant.set(g.tenantId, g._count._all);
      firstPaidByTenant.set(g.tenantId, g._min.paidAt ?? null);
    }
    const payerIds = [...totalByTenant.keys()];

    // Datos de los tenants pagadores (nombre + vida útil).
    const payerTenants =
      payerIds.length > 0
        ? await this.admin.tenant.findMany({
            where: { id: { in: payerIds } },
            select: { id: true, name: true, createdAt: true, status: true, updatedAt: true },
          })
        : [];

    const now = new Date();
    let sumTotal = 0;
    let sumArpa = 0;
    let sumLifespan = 0;
    for (const t of payerTenants) {
      const totalPaid = totalByTenant.get(t.id) ?? 0;
      const churned = t.status === 'cancelled' || t.status === 'suspended';
      const end = churned ? t.updatedAt : now;
      const lifespanMonths = Math.max(
        monthDiff(startOfMonthUtc(t.createdAt), startOfMonthUtc(end)),
        1,
      );
      sumTotal += totalPaid;
      sumLifespan += lifespanMonths;
      sumArpa += totalPaid / lifespanMonths;
    }
    const payingTenants = payerTenants.length;
    const avgArpa = payingTenants > 0 ? sumArpa / payingTenants : 0;
    const avgLifespanMonths = payingTenants > 0 ? sumLifespan / payingTenants : 0;
    const realizedLtv = payingTenants > 0 ? sumTotal / payingTenants : 0;
    const avgLtv = avgArpa * avgLifespanMonths;

    // Top 10 por LTV realizado (Σ pagos).
    const nameById = new Map(payerTenants.map((t) => [t.id, t.name]));
    const topTenants = payerIds
      .map((id) => ({
        tenantId: id,
        name: nameById.get(id) ?? '—',
        totalPaid: round2(totalByTenant.get(id) ?? 0),
        paymentsCount: countByTenant.get(id) ?? 0,
        firstPaidAt: firstPaidByTenant.get(id)?.toISOString() ?? null,
      }))
      .sort((a, b) => b.totalPaid - a.totalPaid)
      .slice(0, 10);

    // Cohortes de ingresos por mes de alta (últimos `span` meses).
    const cohortTenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, billingExempt: false, createdAt: { gte: firstCohort } },
      select: { id: true, createdAt: true },
    });
    const cohortAcc = new Map<string, { tenants: number; revenue: number }>();
    for (const t of cohortTenants) {
      const key = monthKey(startOfMonthUtc(t.createdAt));
      const slice = cohortAcc.get(key) ?? { tenants: 0, revenue: 0 };
      slice.tenants += 1;
      slice.revenue += totalByTenant.get(t.id) ?? 0;
      cohortAcc.set(key, slice);
    }
    const cohorts = [];
    for (let i = 0; i < span; i++) {
      const c = addMonthsUtc(firstCohort, i);
      const slice = cohortAcc.get(monthKey(c)) ?? { tenants: 0, revenue: 0 };
      cohorts.push({
        cohortMonth: monthLabel(c),
        tenants: slice.tenants,
        revenue: round2(slice.revenue),
        revenuePerTenant: slice.tenants > 0 ? round2(slice.revenue / slice.tenants) : 0,
      });
    }

    return {
      currency: 'EUR',
      payingTenants,
      avgLtv: round2(avgLtv),
      realizedLtv: round2(realizedLtv),
      avgLifespanMonths: round2(avgLifespanMonths),
      avgArpa: round2(avgArpa),
      topTenants,
      cohorts,
    };
  }

  /**
   * Retry analysis de cobros de la suscripción SaaS: de las facturas de Stripe
   * que fallaron al menos una vez en la ventana (`firstFailedAt`), cuántas se
   * acabaron cobrando (`recoveredAt`), la tasa de recuperación, el importe en
   * riesgo (no recuperado) vs recuperado y los intentos medios.
   */
  async getPaymentRetryAnalysis(months: number): Promise<AdminPaymentRetryAnalysisDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const windowStart = addMonthsUtc(startOfMonthUtc(new Date()), -(span - 1));

    const rows = await this.admin.tenantSubscriptionPayment.findMany({
      where: { firstFailedAt: { gte: windowStart } },
      select: { amount: true, recoveredAt: true, failedAttempts: true },
    });

    let recovered = 0;
    let amountRecovered = 0;
    let stillFailing = 0;
    let amountAtRisk = 0;
    let totalAttempts = 0;
    for (const r of rows) {
      totalAttempts += r.failedAttempts;
      const amount = Number(r.amount);
      if (r.recoveredAt) {
        recovered += 1;
        amountRecovered += amount;
      } else {
        stillFailing += 1;
        amountAtRisk += amount;
      }
    }
    const totalFailed = rows.length;
    return {
      months: span,
      totalFailed,
      recovered,
      stillFailing,
      recoveryRatePercent: totalFailed > 0 ? round2((recovered / totalFailed) * 100) : 0,
      avgAttempts: totalFailed > 0 ? round2(totalAttempts / totalFailed) : 0,
      amountAtRisk: round2(amountAtRisk),
      amountRecovered: round2(amountRecovered),
      currency: 'EUR',
    };
  }
}
