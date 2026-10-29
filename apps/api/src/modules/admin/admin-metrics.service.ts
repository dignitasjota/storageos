import { Injectable } from '@nestjs/common';

import { TtlCache } from '../../common/cache/ttl-cache';
import {
  aliveAtWhere,
  churnDate,
  churnedBetweenWhere,
  CHURNED_STATUSES,
  isLiveTenantStatus,
  netPaid,
} from '../../common/saas-metrics';
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

  /** Caché de 60 s de las agregaciones cross-tenant (el panel re-consulta a menudo). */
  private readonly overviewCache = new TtlCache<AdminMetricsDto>();
  private readonly retentionCache = new TtlCache<AdminRetentionDto>();
  private readonly ltvCache = new TtlCache<AdminLtvDto>();

  /** `months` = tamaño de las series y del periodo que se compara (1-24). */
  getOverview(months = 12): Promise<AdminMetricsDto> {
    const span = Math.min(Math.max(Math.trunc(months) || 12, 1), 24);
    return this.overviewCache.get(`overview:${span}`, () => this.computeOverview(span));
  }

  getRetention(months: number): Promise<AdminRetentionDto> {
    return this.retentionCache.get(String(months), () => this.computeRetention(months));
  }

  getLtv(months: number): Promise<AdminLtvDto> {
    return this.ltvCache.get(String(months), () => this.computeLtv(months));
  }

  private async computeOverview(span: number): Promise<AdminMetricsDto> {
    const now = new Date();
    const monthStart = startOfMonthUtc(now);

    // Ventana de `span` meses (UTC) para las series mensuales, y la misma
    // ventana justo antes para comparar.
    const baseY = now.getUTCFullYear();
    const baseM = now.getUTCMonth();
    const months = Array.from({ length: span }, (_, idx) => {
      const d = new Date(Date.UTC(baseY, baseM - (span - 1 - idx), 1));
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      return {
        key: `${year}-${String(month).padStart(2, '0')}`,
        label: `${MONTHS_ES[month - 1]} ${String(year % 100).padStart(2, '0')}`,
      };
    });
    const from12 = new Date(Date.UTC(baseY, baseM - (span - 1), 1));
    const fromPrev = new Date(Date.UTC(baseY, baseM - (2 * span - 1), 1));
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
        where: { billingExempt: false, createdAt: { gte: monthStart } },
      }),
      // Bajas: cancelados o suspendidos por su fecha de baja, también los
      // anonimizados (borrados), igual que «Churn por razón».
      this.admin.tenant.count({ where: churnedBetweenWhere(monthStart) }),
      // Base del churn: los que estaban vivos al empezar el mes.
      this.admin.tenant.count({ where: aliveAtWhere(monthStart) }),
      this.admin.tenantSubscription.findMany({
        where: { tenant: { deletedAt: null, billingExempt: false } },
        select: {
          tenantId: true,
          status: true,
          tenant: { select: { status: true } },
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
        where: { billingExempt: false, createdAt: { gte: fromPrev } },
        select: { createdAt: true },
      }),
      this.admin.tenant.findMany({
        where: churnedBetweenWhere(fromPrev),
        select: { canceledAt: true, updatedAt: true },
      }),
      // Ingresos netos: lo cobrado menos lo devuelto (reembolsos y contracargos
      // perdidos); los reembolsados del todo quedan en `refunded`.
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: ['paid', 'partially_refunded', 'refunded'] },
          paidAt: { gte: fromPrev },
        },
        select: { paidAt: true, amount: true, refundedAmount: true },
      }),
    ]);

    const trialsEnded = await this.admin.tenant.findMany({
      where: { billingExempt: false, trialEndedAt: { gte: monthStart } },
      select: {
        status: true,
        subscription: { select: { status: true, plan: { select: { priceMonthly: true } } } },
      },
    });
    const trialsEndedThisMonth = { ended: trialsEnded.length, converted: 0, toFree: 0, churned: 0 };
    for (const t of trialsEnded) {
      if ((CHURNED_STATUSES as readonly string[]).includes(t.status)) {
        trialsEndedThisMonth.churned += 1;
      } else if (
        t.subscription?.status === 'active' &&
        Number(t.subscription.plan.priceMonthly) > 0
      ) {
        trialsEndedThisMonth.converted += 1;
      } else {
        trialsEndedThisMonth.toFree += 1;
      }
    }

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
    let payingTenants = 0;
    for (const s of subscriptions) {
      const slug = s.plan.slug;
      const entry = planMap.get(slug) ?? {
        planSlug: slug,
        planName: s.plan.name,
        count: 0,
        mrr: 0,
      };
      entry.count += 1;
      // Solo pagan las suscripciones activas de tenants vivos: suspender a mano
      // no toca la suscripción.
      if (s.status === 'active' && isLiveTenantStatus(s.tenant.status)) {
        const monthly = Number(s.plan.priceMonthly);
        if (monthly > 0) payingTenants += 1;
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
      const k = monthKey(churnDate(r));
      cancelsByKey.set(k, (cancelsByKey.get(k) ?? 0) + 1);
    }
    const revenueByKey = new Map<string, number>();
    for (const r of revenueRows) {
      if (!r.paidAt) continue;
      const k = monthKey(r.paidAt);
      revenueByKey.set(k, (revenueByKey.get(k) ?? 0) + netPaid(r));
    }

    // Totales del periodo y del anterior (las filas empiezan en `fromPrev`).
    const totals = (from: Date, to: Date | null) => ({
      signups: signupRows.filter((r) => r.createdAt >= from && (!to || r.createdAt < to)).length,
      cancellations: cancelRows.filter((r) => {
        const d = churnDate(r);
        return d >= from && (!to || d < to);
      }).length,
      collected: round2(
        revenueRows
          .filter((r) => r.paidAt && r.paidAt >= from && (!to || r.paidAt < to))
          .reduce((sum, r) => sum + netPaid(r), 0),
      ),
    });
    const period = {
      months: span,
      current: totals(from12, null),
      previous: totals(fromPrev, from12),
    };

    const churnRatePercent =
      totalAtMonthStart > 0 ? (cancellationsThisMonth / totalAtMonthStart) * 100 : 0;

    return {
      tenants,
      mrr: { total: round2(mrrTotal), currency: 'EUR' },
      signupsThisMonth,
      cancellationsThisMonth,
      churnRatePercent: round2(churnRatePercent),
      averageRevenuePerTenant: payingTenants > 0 ? round2(mrrTotal / payingTenants) : 0,
      payingTenants,
      trialsEndedThisMonth,
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
      period,
    };
  }

  /**
   * Matriz de cohortes de retención: agrupa los tenants por su mes de alta y,
   * para cada offset de mes, calcula el % que seguía vivo. "Vivo" = no
   * `cancelled`/`suspended`; la fecha de baja es `canceledAt` (o `updatedAt` en
   * las bajas antiguas). Cuenta también a los anonimizados. M0 es 100% por
   * construcción; una cohorte sin altas no tiene porcentaje.
   */
  private async computeRetention(months: number): Promise<AdminRetentionDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const nowMonth = startOfMonthUtc(new Date());
    const firstCohort = addMonthsUtc(nowMonth, -(span - 1));

    const tenants = await this.admin.tenant.findMany({
      where: { billingExempt: false, createdAt: { gte: firstCohort } },
      select: { createdAt: true, status: true, updatedAt: true, canceledAt: true },
    });

    // Por tenant: mes de alta + mes de baja (null si sigue vivo).
    const records = tenants.map((t) => {
      const cohortMonth = startOfMonthUtc(t.createdAt);
      const churned = (CHURNED_STATUSES as readonly string[]).includes(t.status);
      return { cohortMonth, churnMonth: churned ? startOfMonthUtc(churnDate(t)) : null };
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
          retention.push(null);
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
      // Misma definición de baja que el KPI de Métricas (anonimizados incluidos).
      where: churnedBetweenWhere(windowStart),
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
  private async computeLtv(months: number): Promise<AdminLtvDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const nowMonth = startOfMonthUtc(new Date());
    const firstCohort = addMonthsUtc(nowMonth, -(span - 1));

    // Agregado por tenant de sus pagos `paid` (una sola agregación en BD).
    const payGroups = await this.admin.tenantSubscriptionPayment.groupBy({
      by: ['tenantId'],
      where: { status: { in: ['paid', 'partially_refunded', 'refunded'] } },
      _sum: { amount: true, refundedAmount: true },
      _count: { _all: true },
      _min: { paidAt: true },
    });

    const totalByTenant = new Map<string, number>();
    const countByTenant = new Map<string, number>();
    const firstPaidByTenant = new Map<string, Date | null>();
    for (const g of payGroups) {
      // Neto: lo cobrado menos lo devuelto.
      totalByTenant.set(
        g.tenantId,
        Math.max(0, Number(g._sum.amount ?? 0) - Number(g._sum.refundedAmount ?? 0)),
      );
      countByTenant.set(g.tenantId, g._count._all);
      firstPaidByTenant.set(g.tenantId, g._min.paidAt ?? null);
    }
    const payerIds = [...totalByTenant.keys()];

    // Datos de los tenants pagadores (nombre + vida útil).
    const payerTenants =
      payerIds.length > 0
        ? await this.admin.tenant.findMany({
            where: { id: { in: payerIds } },
            select: {
              id: true,
              name: true,
              createdAt: true,
              status: true,
              updatedAt: true,
              canceledAt: true,
            },
          })
        : [];

    const now = new Date();
    let sumTotal = 0;
    let sumArpa = 0;
    let sumLifespan = 0;
    for (const t of payerTenants) {
      const totalPaid = totalByTenant.get(t.id) ?? 0;
      const churned = (CHURNED_STATUSES as readonly string[]).includes(t.status);
      const end = churned ? churnDate(t) : now;
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
      where: { billingExempt: false, createdAt: { gte: firstCohort } },
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
   * Recuperación de cobros fallidos de la suscripción. Tres fuentes:
   *  - Stripe: facturas con `firstFailedAt` (recuperadas = `recoveredAt`).
   *  - Adeudos SEPA devueltos: un episodio por tenant y periodo.
   *  - Cobro automático de Redsys rechazado: los intentos seguidos de un tenant
   *    forman un episodio.
   * Un episodio SEPA o Redsys está recuperado si el tenant pagó después.
   */
  async getPaymentRetryAnalysis(months: number): Promise<AdminPaymentRetryAnalysisDto> {
    const span = Math.min(Math.max(months, 1), 24);
    const windowStart = addMonthsUtc(startOfMonthUtc(new Date()), -(span - 1));

    const [stripeRows, sepaRows, redsysRows] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: { firstFailedAt: { gte: windowStart } },
        select: { amount: true, recoveredAt: true, failedAttempts: true },
      }),
      this.admin.platformSepaRemittanceItem.findMany({
        where: { itemStatus: 'bounced', bouncedAt: { gte: windowStart } },
        select: { tenantId: true, amount: true, bouncedAt: true, periodCovered: true },
        orderBy: { bouncedAt: 'asc' },
      }),
      this.admin.platformRedsysOrder.findMany({
        where: { kind: 'auto', status: 'failed', createdAt: { gte: windowStart } },
        select: { tenantId: true, amountCents: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    type Episode = { amount: number; attempts: number; recovered: boolean };
    const stripe: Episode[] = stripeRows.map((r) => ({
      amount: Number(r.amount),
      attempts: Math.max(1, r.failedAttempts),
      recovered: Boolean(r.recoveredAt),
    }));

    // Pagos de los tenants afectados, para saber si pagaron después del fallo.
    const tenantIds = [...new Set([...sepaRows, ...redsysRows].map((r) => r.tenantId))];
    const paid =
      tenantIds.length > 0
        ? await this.admin.tenantSubscriptionPayment.findMany({
            where: {
              tenantId: { in: tenantIds },
              status: { in: ['paid', 'partially_refunded'] },
              paidAt: { gte: windowStart },
            },
            select: { tenantId: true, paidAt: true },
          })
        : [];
    const paidAtByTenant = new Map<string, number[]>();
    for (const p of paid) {
      if (!p.paidAt) continue;
      const list = paidAtByTenant.get(p.tenantId) ?? [];
      list.push(p.paidAt.getTime());
      paidAtByTenant.set(p.tenantId, list);
    }
    /** Primer pago del tenant posterior a `at` (null si no ha pagado). */
    const paidAfter = (tenantId: string, at: Date): number | null => {
      const later = (paidAtByTenant.get(tenantId) ?? []).filter((t) => t > at.getTime());
      return later.length > 0 ? Math.min(...later) : null;
    };

    const sepaEpisodes = new Map<string, Episode & { first: Date; tenantId: string }>();
    for (const r of sepaRows) {
      if (!r.bouncedAt) continue;
      const key = `${r.tenantId}:${r.periodCovered.toISOString().slice(0, 10)}`;
      const e = sepaEpisodes.get(key);
      if (e) e.attempts += 1;
      else
        sepaEpisodes.set(key, {
          tenantId: r.tenantId,
          first: r.bouncedAt,
          amount: r.amount / 100,
          attempts: 1,
          recovered: false,
        });
    }
    const sepa: Episode[] = [...sepaEpisodes.values()].map((e) => ({
      amount: e.amount,
      attempts: e.attempts,
      recovered: paidAfter(e.tenantId, e.first) !== null,
    }));

    const redsys: Episode[] = [];
    const redsysByTenant = new Map<string, typeof redsysRows>();
    for (const r of redsysRows) {
      const list = redsysByTenant.get(r.tenantId) ?? [];
      list.push(r);
      redsysByTenant.set(r.tenantId, list);
    }
    for (const [tenantId, rows] of redsysByTenant) {
      let current: (Episode & { until: number | null }) | null = null;
      for (const r of rows) {
        // Un intento posterior al pago que cerró el episodio abre otro.
        if (current && (current.until === null || r.createdAt.getTime() < current.until)) {
          current.attempts += 1;
          continue;
        }
        if (current) redsys.push(current);
        const until = paidAfter(tenantId, r.createdAt);
        current = { amount: r.amountCents / 100, attempts: 1, recovered: until !== null, until };
      }
      if (current) redsys.push(current);
    }

    const all = [...stripe, ...sepa, ...redsys];
    let recovered = 0;
    let amountRecovered = 0;
    let amountAtRisk = 0;
    let totalAttempts = 0;
    for (const e of all) {
      totalAttempts += e.attempts;
      if (e.recovered) {
        recovered += 1;
        amountRecovered += e.amount;
      } else {
        amountAtRisk += e.amount;
      }
    }
    const totalFailed = all.length;
    const bySource = (
      [
        ['stripe', stripe],
        ['sepa', sepa],
        ['redsys', redsys],
      ] as const
    ).map(([source, list]) => ({
      source,
      totalFailed: list.length,
      recovered: list.filter((e) => e.recovered).length,
    }));
    return {
      months: span,
      totalFailed,
      recovered,
      stillFailing: totalFailed - recovered,
      recoveryRatePercent: totalFailed > 0 ? round2((recovered / totalFailed) * 100) : 0,
      avgAttempts: totalFailed > 0 ? round2(totalAttempts / totalFailed) : 0,
      amountAtRisk: round2(amountAtRisk),
      amountRecovered: round2(amountRecovered),
      currency: 'EUR',
      bySource,
    };
  }
}
