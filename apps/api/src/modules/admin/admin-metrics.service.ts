import { Injectable } from '@nestjs/common';

import { TtlCache } from '../../common/cache/ttl-cache';
import {
  churnedBetween,
  COLLECTED_PAYMENT_STATUSES,
  currentMrrByTenant,
  isPayingSubscription,
  loadPayerLifecycles,
  madridMonthIndex,
  monthIndexKey,
  monthIndexLabel,
  monthIndexStart,
  netPaid,
  payingAt,
  tenantMetricsState,
  trialOutcome,
} from '../../common/saas-metrics';
import { UNANSWERED_ADMIN_MESSAGE } from '../../common/support-ticket-filters';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { MrrSnapshotService } from './mrr-snapshot.service';

import type {
  AdminChurnByReasonDto,
  AdminLtvDto,
  AdminMetricsDto,
  AdminPaymentRetryAnalysisDto,
  AdminRetentionDto,
} from '@storageos/shared';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Normaliza el nº de meses de una petición (1-24). */
const spanOf = (months: number, fallback = 12): number =>
  Math.min(Math.max(Math.trunc(months) || fallback, 1), 24);

/**
 * Métricas globales del SaaS para el dashboard del super admin: estado de los
 * tenants, MRR (sin IVA, `tenantMrr`), ARPU, crecimiento e ingresos por mes,
 * distribución por plan, totales de plataforma y un par de alertas operativas.
 * Los meses se cortan en hora de España. Las definiciones (quién paga, quién es
 * baja, qué es solo lectura) están en `common/saas-metrics.ts`.
 */
@Injectable()
export class AdminMetricsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly mrr: MrrSnapshotService,
  ) {}

  /** Caché de 60 s de las agregaciones cross-tenant (el panel re-consulta a menudo). */
  private readonly overviewCache = new TtlCache<AdminMetricsDto>();
  private readonly retentionCache = new TtlCache<AdminRetentionDto>();
  private readonly ltvCache = new TtlCache<AdminLtvDto>();

  /** `months` = tamaño de las series y del periodo que se compara (1-24). */
  getOverview(months = 12): Promise<AdminMetricsDto> {
    const span = spanOf(months);
    return this.overviewCache.get(`overview:${span}`, () => this.computeOverview(span));
  }

  getRetention(months: number): Promise<AdminRetentionDto> {
    const span = spanOf(months);
    return this.retentionCache.get(String(span), () => this.computeRetention(span));
  }

  getLtv(months: number): Promise<AdminLtvDto> {
    const span = spanOf(months);
    return this.ltvCache.get(String(span), () => this.computeLtv(span));
  }

  private async computeOverview(span: number): Promise<AdminMetricsDto> {
    const now = new Date();
    const nowIdx = madridMonthIndex(now);
    const monthStart = monthIndexStart(nowIdx);
    // Ventana de `span` meses para las series y la misma ventana justo antes.
    const firstIdx = nowIdx - (span - 1);
    const from12 = monthIndexStart(firstIdx);
    const fromPrev = monthIndexStart(firstIdx - span);
    const trialSoon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [
      tenantRows,
      signupsThisMonth,
      payers,
      paying,
      subscriptions,
      trialsExpiringSoon,
      openSupportTickets,
      facilities,
      units,
      customers,
      contracts,
      users,
      signupRows,
      revenueRows,
      trialsEnded,
    ] = await Promise.all([
      // Las cuentas EXENTAS (billingExempt) quedan fuera de toda métrica de
      // negocio: no cuentan al MRR/ARPU/ingresos, ni a estados/crecimiento/trials.
      this.admin.tenant.findMany({
        where: { deletedAt: null, billingExempt: false },
        select: { status: true, subscription: { select: { status: true } } },
      }),
      this.admin.tenant.count({
        where: { billingExempt: false, createdAt: { gte: monthStart } },
      }),
      loadPayerLifecycles(this.admin, now),
      currentMrrByTenant(this.admin),
      this.admin.tenantSubscription.findMany({
        where: { tenant: { deletedAt: null, billingExempt: false } },
        select: {
          tenantId: true,
          status: true,
          tenant: { select: { status: true } },
          plan: { select: { slug: true, name: true } },
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
        where: {
          status: { in: ['open', 'in_progress', 'waiting_user'] },
          NOT: UNANSWERED_ADMIN_MESSAGE,
        },
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
      // Ingresos netos: lo cobrado menos lo devuelto (reembolsos y contracargos
      // perdidos); los reembolsados del todo quedan en `refunded`.
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: [...COLLECTED_PAYMENT_STATUSES] },
          paidAt: { gte: fromPrev },
        },
        select: { paidAt: true, amount: true, refundedAmount: true },
      }),
      this.admin.tenant.findMany({
        where: { billingExempt: false, trialEndedAt: { gte: monthStart } },
        select: { id: true, status: true },
      }),
    ]);

    // --- Pruebas terminadas este mes ---
    const payerBy = new Map(payers.map((p) => [p.tenantId, p]));
    const trialsEndedThisMonth = { ended: trialsEnded.length, converted: 0, toFree: 0, churned: 0 };
    for (const t of trialsEnded) {
      const outcome = trialOutcome(t, payerBy.get(t.id));
      if (outcome !== 'inTrial') trialsEndedThisMonth[outcome] += 1;
    }

    // --- Tenants por estado (la prueba sin pagar va aparte, en solo lectura) ---
    const tenants = {
      total: 0,
      trial: 0,
      active: 0,
      pastDue: 0,
      readOnly: 0,
      suspended: 0,
      cancelled: 0,
    };
    const STATE_KEY = {
      trial: 'trial',
      active: 'active',
      past_due: 'pastDue',
      read_only: 'readOnly',
      suspended: 'suspended',
      cancelled: 'cancelled',
    } as const;
    for (const t of tenantRows) {
      tenants[STATE_KEY[tenantMetricsState(t.status, t.subscription?.status)]] += 1;
      tenants.total += 1;
    }

    // --- MRR (sin IVA) + distribución por plan de los tenants vivos ---
    let mrrTotal = 0;
    for (const p of paying.values()) mrrTotal += p.total;
    const payingTenants = paying.size;
    const planMap = new Map<
      string,
      {
        planSlug: string;
        planName: string;
        count: number;
        trial: number;
        paying: number;
        mrr: number;
      }
    >();
    for (const s of subscriptions) {
      const state = tenantMetricsState(s.tenant.status, s.status);
      // Solo los vivos: ni suspendidos, ni cancelados, ni en solo lectura.
      if (state === 'suspended' || state === 'cancelled' || state === 'read_only') continue;
      const entry = planMap.get(s.plan.slug) ?? {
        planSlug: s.plan.slug,
        planName: s.plan.name,
        count: 0,
        trial: 0,
        paying: 0,
        mrr: 0,
      };
      entry.count += 1;
      if (state === 'trial') entry.trial += 1;
      const p = paying.get(s.tenantId);
      if (p && isPayingSubscription(s, s.tenant)) {
        entry.paying += 1;
        entry.mrr += p.plan;
      }
      planMap.set(s.plan.slug, entry);
    }
    const tenantsByPlan = [...planMap.values()]
      .map((p) => ({ ...p, mrr: round2(p.mrr) }))
      .sort((a, b) => b.count - a.count);

    // --- Series mensuales (meses en hora de España) ---
    const signupsByIdx = new Map<number, number>();
    for (const r of signupRows) {
      const k = madridMonthIndex(r.createdAt);
      signupsByIdx.set(k, (signupsByIdx.get(k) ?? 0) + 1);
    }
    const cancelsByIdx = new Map<number, number>();
    for (const p of payers) {
      if (!churnedBetween(p, fromPrev)) continue;
      const k = madridMonthIndex(p.churnedAt!);
      cancelsByIdx.set(k, (cancelsByIdx.get(k) ?? 0) + 1);
    }
    const revenueByIdx = new Map<number, number>();
    for (const r of revenueRows) {
      if (!r.paidAt) continue;
      const k = madridMonthIndex(r.paidAt);
      revenueByIdx.set(k, (revenueByIdx.get(k) ?? 0) + netPaid(r));
    }

    // Totales del periodo y del anterior (las filas empiezan en `fromPrev`).
    const totals = (from: Date, to: Date | null) => ({
      signups: signupRows.filter((r) => r.createdAt >= from && (!to || r.createdAt < to)).length,
      cancellations: payers.filter((p) => churnedBetween(p, from, to ?? undefined)).length,
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

    // Churn del mes: bajas de clientes que pagaban / los que pagaban al empezar el mes.
    const cancellationsThisMonth = payers.filter((p) => churnedBetween(p, monthStart)).length;
    const baseAtMonthStart = payers.filter((p) => payingAt(p, monthStart)).length;
    const churnRatePercent =
      baseAtMonthStart > 0 ? (cancellationsThisMonth / baseAtMonthStart) * 100 : 0;

    const monthsIdx = Array.from({ length: span }, (_, i) => firstIdx + i);
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
      monthlyGrowth: monthsIdx.map((idx) => ({
        label: monthIndexLabel(idx),
        signups: signupsByIdx.get(idx) ?? 0,
        cancellations: cancelsByIdx.get(idx) ?? 0,
      })),
      monthlySaasRevenue: monthsIdx.map((idx) => ({
        label: monthIndexLabel(idx),
        collected: round2(revenueByIdx.get(idx) ?? 0),
      })),
      period,
    };
  }

  /**
   * Matriz de cohortes de retención: los tenants que llegaron a pagar, por su
   * mes de alta, y el % que seguía con nosotros en cada mes. Una prueba que
   * acabó sin pagar no entra (no es cliente ni baja); quien pagó y luego quedó
   * en solo lectura cuenta como baja. M0 es 100 % por construcción; una cohorte
   * sin clientes no tiene porcentaje.
   */
  private async computeRetention(span: number): Promise<AdminRetentionDto> {
    const nowIdx = madridMonthIndex(new Date());
    const firstIdx = nowIdx - (span - 1);
    const payers = await loadPayerLifecycles(this.admin);

    const records = payers
      .map((p) => ({
        cohort: madridMonthIndex(p.createdAt),
        churn: p.churnedAt ? madridMonthIndex(p.churnedAt) : null,
      }))
      .filter((r) => r.cohort >= firstIdx);

    const maxOffset = nowIdx - firstIdx;
    const cohorts = [];
    for (let c = firstIdx; c <= nowIdx; c++) {
      const members = records.filter((r) => r.cohort === c);
      const size = members.length;
      const maxK = nowIdx - c;
      const retention: (number | null)[] = [];
      for (let k = 0; k <= maxOffset; k++) {
        if (k > maxK || size === 0) {
          retention.push(null);
          continue;
        }
        const alive = members.filter((r) => r.churn === null || r.churn >= c + k).length;
        retention.push(round2((alive / size) * 100));
      }
      cohorts.push({ cohort: monthIndexLabel(c), size, retention });
    }
    return { maxOffset, cohorts };
  }

  /**
   * Bajas de clientes que pagaban, agrupadas por motivo, en la ventana de N
   * meses. El motivo es el `churnReason` CAPTURADO al suspender/cancelar; si
   * falta se INFIERE: `nonpayment` si la suscripción quedó `past_due` o en solo
   * lectura, `voluntary` si estaba marcada para cancelar a fin de periodo,
   * `unknown` si no. `lostMrr` = su último MRR conocido (sin IVA).
   */
  async getChurnByReason(months: number): Promise<AdminChurnByReasonDto> {
    const span = spanOf(months);
    const windowStart = monthIndexStart(madridMonthIndex(new Date()) - (span - 1));
    const payers = (await loadPayerLifecycles(this.admin)).filter((p) =>
      churnedBetween(p, windowStart),
    );

    const acc = new Map<string, { count: number; lostMrr: number; captured: number }>();
    let lostMrr = 0;
    for (const t of payers) {
      const captured = Boolean(t.churnReason);
      let reason = t.churnReason;
      if (!reason) {
        if (t.subscription?.status === 'past_due' || t.subscription?.status === 'expired') {
          reason = 'nonpayment';
        } else if (t.subscription?.cancelAtPeriodEnd) reason = 'voluntary';
        else reason = 'unknown';
      }
      const slice = acc.get(reason) ?? { count: 0, lostMrr: 0, captured: 0 };
      slice.count += 1;
      slice.lostMrr += t.lastMrr;
      if (captured) slice.captured += 1;
      acc.set(reason, slice);
      lostMrr += t.lastMrr;
    }

    const slices = [...acc.entries()]
      .map(([reason, s]) => ({
        reason,
        count: s.count,
        lostMrr: round2(s.lostMrr),
        captured: s.captured,
      }))
      .sort((a, b) => b.count - a.count);

    return { months: span, totalChurned: payers.length, lostMrr: round2(lostMrr), slices };
  }

  /**
   * LTV (valor de vida del cliente) + cohortes de ingresos del SaaS.
   *
   *  - LTV realizado = Σ pagos netos (con IVA) / nº de tenants con algún pago.
   *  - Vida media = meses entre el alta y la baja (o hoy), mínimo 1.
   *  - LTV (modelo, sin IVA) = ARPA / churn mensual medio del MRR. ARPA = MRR /
   *    tenants que pagan ahora; churn mensual = MRR perdido por bajas / MRR al
   *    empezar el mes, de media en los meses cerrados con datos. Con menos de 3
   *    meses o sin ninguna baja de MRR no se calcula (`null`).
   *
   * Cohortes de ingresos: por mes de alta (últimos N meses), el ingreso
   * ACUMULADO (Σ pagos netos de esos tenants) y el nº de tenants de la cohorte.
   */
  private async computeLtv(span: number): Promise<AdminLtvDto> {
    const nowIdx = madridMonthIndex(new Date());
    const firstIdx = nowIdx - (span - 1);

    const [payGroups, paying, movements] = await Promise.all([
      this.admin.tenantSubscriptionPayment.groupBy({
        by: ['tenantId'],
        where: { status: { in: [...COLLECTED_PAYMENT_STATUSES] } },
        _sum: { amount: true, refundedAmount: true },
        _count: { _all: true },
        _min: { paidAt: true },
      }),
      currentMrrByTenant(this.admin),
      this.mrr.getMovements(12),
    ]);

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

    const lifecycles = await loadPayerLifecycles(this.admin);
    const lifeBy = new Map(lifecycles.map((p) => [p.tenantId, p]));
    const payerTenants =
      payerIds.length > 0
        ? await this.admin.tenant.findMany({
            where: { id: { in: payerIds }, billingExempt: false },
            select: { id: true, name: true, createdAt: true },
          })
        : [];

    const now = new Date();
    let sumTotal = 0;
    let sumLifespan = 0;
    for (const t of payerTenants) {
      const end = lifeBy.get(t.id)?.churnedAt ?? now;
      const lifespanMonths = Math.max(madridMonthIndex(end) - madridMonthIndex(t.createdAt), 1);
      sumTotal += totalByTenant.get(t.id) ?? 0;
      sumLifespan += lifespanMonths;
    }
    const payingTenantsCount = payerTenants.length;
    const avgLifespanMonths = payingTenantsCount > 0 ? sumLifespan / payingTenantsCount : 0;
    const realizedLtv = payingTenantsCount > 0 ? sumTotal / payingTenantsCount : 0;

    let mrrTotal = 0;
    for (const p of paying.values()) mrrTotal += p.total;
    const avgArpa = paying.size > 0 ? mrrTotal / paying.size : 0;
    const closed = this.mrr.closedMonthsWithData(movements.months).filter((m) => m.baseMrr > 0);
    const churnRates = closed.map((m) => m.churn / m.baseMrr);
    const avgChurn =
      churnRates.length > 0 ? churnRates.reduce((s, r) => s + r, 0) / churnRates.length : 0;
    const enoughHistory = closed.length >= 3 && avgChurn > 0;
    const avgLtv = enoughHistory ? avgArpa / avgChurn : null;

    // Top 10 por LTV realizado (Σ pagos).
    const nameById = new Map(payerTenants.map((t) => [t.id, t.name]));
    const topTenants = payerTenants
      .map((t) => ({
        tenantId: t.id,
        name: nameById.get(t.id) ?? '—',
        totalPaid: round2(totalByTenant.get(t.id) ?? 0),
        paymentsCount: countByTenant.get(t.id) ?? 0,
        firstPaidAt: firstPaidByTenant.get(t.id)?.toISOString() ?? null,
      }))
      .sort((a, b) => b.totalPaid - a.totalPaid)
      .slice(0, 10);

    // Cohortes de ingresos por mes de alta (últimos `span` meses).
    const cohortTenants = await this.admin.tenant.findMany({
      where: { billingExempt: false, createdAt: { gte: monthIndexStart(firstIdx) } },
      select: { id: true, createdAt: true },
    });
    const cohortAcc = new Map<string, { tenants: number; revenue: number }>();
    for (const t of cohortTenants) {
      const key = monthIndexKey(madridMonthIndex(t.createdAt));
      const slice = cohortAcc.get(key) ?? { tenants: 0, revenue: 0 };
      slice.tenants += 1;
      slice.revenue += totalByTenant.get(t.id) ?? 0;
      cohortAcc.set(key, slice);
    }
    const cohorts = [];
    for (let idx = firstIdx; idx <= nowIdx; idx++) {
      const slice = cohortAcc.get(monthIndexKey(idx)) ?? { tenants: 0, revenue: 0 };
      cohorts.push({
        cohortMonth: monthIndexLabel(idx),
        tenants: slice.tenants,
        revenue: round2(slice.revenue),
        revenuePerTenant: slice.tenants > 0 ? round2(slice.revenue / slice.tenants) : 0,
      });
    }

    return {
      currency: 'EUR',
      payingTenants: payingTenantsCount,
      avgLtv: avgLtv === null ? null : round2(avgLtv),
      avgMonthlyChurnPct: enoughHistory ? round2(avgChurn * 100) : null,
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
    const span = spanOf(months);
    const windowStart = monthIndexStart(madridMonthIndex(new Date()) - (span - 1));

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
