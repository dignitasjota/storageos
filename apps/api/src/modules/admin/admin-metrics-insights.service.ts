import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BREAKDOWN_METRICS,
  CLIENT_STATE_LABELS,
  concentrationShares,
  MONTH_PARAM_REGEX,
  MRR_MOVEMENT_KINDS,
  REVENUE_SERIES_BY,
  type AdminBreakdownDto,
  type AdminBreakdownMetric,
  type AdminBreakdownRowDto,
  type AdminClientStateDto,
  type AdminClientStatesDto,
  type AdminClientStatesMonthDto,
  type AdminConcentrationDto,
  type AdminMetricAnnotationDto,
  type AdminMrrMovementKind,
  type AdminRevenueSeriesBy,
  type AdminRevenueSeriesDto,
  type CreateMetricAnnotationInput,
  type UpdateMetricAnnotationInput,
} from '@storageos/shared';

import {
  churnDate,
  churnedBetween,
  COLLECTED_PAYMENT_STATUSES,
  currentMrrByTenant,
  dateMonthIndex,
  financeSource,
  isChurnedStatus,
  listPriceWithoutVat,
  loadMrrContext,
  loadPayerLifecycles,
  madridMonthIndex,
  monthIndexDate,
  monthIndexKey,
  monthIndexLabel,
  monthIndexStart,
  mrrFor,
  MRR_SUBSCRIPTION_SELECT,
  netPaid,
  tenantMetricsState,
  type TenantMetricsState,
} from '../../common/saas-metrics';
import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { MrrSnapshotService } from './mrr-snapshot.service';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const DAY_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Europe/Madrid',
});
const dayText = (d: Date) => DAY_FORMAT.format(d);

const SOURCE_LABELS = {
  stripe: 'Stripe',
  sepa: 'Remesa SEPA',
  redsys: 'Redsys',
  manual: 'A mano',
} as const;

const MOVEMENT_LABELS: Record<AdminMrrMovementKind, string> = {
  new: 'Nuevo',
  expansion: 'Expansión',
  reactivation: 'Reactivación',
  contraction: 'Contracción',
  churn: 'Bajas',
};

/** Índice de mes de un «AAAA-MM» (o el mes en curso si viene vacío). */
function monthParamIndex(month: string | undefined, nowIdx: number): number {
  if (!month) return nowIdx;
  if (!MONTH_PARAM_REGEX.test(month)) {
    throw new BadRequestException({ code: 'invalid_month', message: 'Mes AAAA-MM' });
  }
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1);
  if (idx > nowIdx) {
    throw new BadRequestException({
      code: 'month_in_future',
      message: 'Ese mes todavía no ha empezado.',
    });
  }
  return idx;
}

/**
 * Lo nuevo de Métricas: estados de cliente con su MRR, concentración de
 * ingresos, series por plan/extra/forma de cobro/comercial, el desglose de una
 * cifra en los tenants que la forman y las anotaciones de los gráficos. Las
 * definiciones (quién paga, quién es baja) son las de `common/saas-metrics.ts`.
 */
@Injectable()
export class AdminMetricsInsightsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly mrr: MrrSnapshotService,
  ) {}

  // --- Estados de cliente ----------------------------------------------------

  /**
   * Cuántos clientes hay en cada estado y su MRR (real, el que pagarían o el
   * que se perdió), y la evolución mes a mes. «De baja» son los que pagaron y
   * se fueron; una prueba que terminó sin pagar está en solo lectura.
   */
  async clientStates(months: number): Promise<AdminClientStatesDto> {
    const now = new Date();
    const nowIdx = madridMonthIndex(now);
    const firstIdx = nowIdx - (months - 1);
    const [tenants, payers, paying, ctx, snapshots] = await Promise.all([
      this.admin.tenant.findMany({
        where: { billingExempt: false },
        select: {
          id: true,
          status: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          canceledAt: true,
          trialEndedAt: true,
          subscription: { select: MRR_SUBSCRIPTION_SELECT },
        },
      }),
      loadPayerLifecycles(this.admin, now),
      currentMrrByTenant(this.admin),
      loadMrrContext(this.admin),
      this.admin.mrrSnapshot.findMany({
        where: {
          month: { gte: monthIndexDate(firstIdx), lt: monthIndexDate(nowIdx) },
          mrr: { gt: 0 },
        },
        select: { month: true, status: true, mrr: true },
      }),
    ]);
    const payerBy = new Map(payers.map((p) => [p.tenantId, p]));

    const acc: Record<AdminClientStateDto['state'], { count: number; mrr: number }> = {
      trial: { count: 0, mrr: 0 },
      paying: { count: 0, mrr: 0 },
      past_due: { count: 0, mrr: 0 },
      read_only: { count: 0, mrr: 0 },
      churned: { count: 0, mrr: 0 },
      free: { count: 0, mrr: 0 },
    };
    for (const t of tenants) {
      if (t.deletedAt) continue;
      const state = tenantMetricsState(t.status, t.subscription?.status);
      const p = paying.get(t.id);
      const potential = t.subscription ? mrrFor(ctx, t.id, t.subscription).total : 0;
      if (state === 'trial') {
        acc.trial.count += 1;
        acc.trial.mrr += potential;
      } else if (p) {
        const key = p.subscriptionStatus === 'past_due' ? 'past_due' : 'paying';
        acc[key].count += 1;
        acc[key].mrr += p.total;
      } else if (state === 'read_only' && !payerBy.has(t.id)) {
        acc.read_only.count += 1;
        acc.read_only.mrr += potential;
      } else if (state === 'active' || state === 'past_due') {
        acc.free.count += 1;
      }
    }
    for (const p of payers) {
      if (!p.churnedAt) continue;
      acc.churned.count += 1;
      acc.churned.mrr += p.lastMrr;
    }
    const kindOf = (s: AdminClientStateDto['state']): AdminClientStateDto['mrrKind'] =>
      s === 'paying' || s === 'past_due' || s === 'free'
        ? 'real'
        : s === 'churned'
          ? 'lost'
          : 'potential';
    const states: AdminClientStateDto[] = (
      ['trial', 'paying', 'past_due', 'read_only', 'churned', 'free'] as const
    ).map((state) => ({
      state,
      count: acc[state].count,
      mrr: round2(acc[state].mrr),
      mrrKind: kindOf(state),
    }));

    // --- Evolución (derivada: snapshots para quien paga, fechas para el resto) ---
    const snapBy = new Map<number, { paying: number; pastDue: number; mrr: number }>();
    for (const sn of snapshots) {
      const idx = dateMonthIndex(sn.month);
      const e = snapBy.get(idx) ?? { paying: 0, pastDue: 0, mrr: 0 };
      if (sn.status === 'past_due') e.pastDue += 1;
      else e.paying += 1;
      e.mrr += Number(sn.mrr);
      snapBy.set(idx, e);
    }
    const evolution: AdminClientStatesMonthDto[] = [];
    for (let idx = firstIdx; idx <= nowIdx; idx++) {
      const end = idx === nowIdx ? now : monthIndexStart(idx + 1);
      let trial = 0;
      let readOnly = 0;
      for (const t of tenants) {
        if (t.createdAt >= end) continue;
        const inTrial = t.trialEndedAt ? t.trialEndedAt >= end : t.status === 'trial';
        if (inTrial) {
          trial += 1;
          continue;
        }
        if (!t.trialEndedAt || t.trialEndedAt >= end) continue;
        const payer = payerBy.get(t.id);
        if (payer && payer.firstPaidAt < end) continue;
        if (isChurnedStatus(t.status) && churnDate(t) < end) continue;
        readOnly += 1;
      }
      const sn =
        idx === nowIdx
          ? {
              paying: acc.paying.count,
              pastDue: acc.past_due.count,
              mrr: acc.paying.mrr + acc.past_due.mrr,
            }
          : (snapBy.get(idx) ?? { paying: 0, pastDue: 0, mrr: 0 });
      evolution.push({
        label: monthIndexLabel(idx),
        month: monthIndexKey(idx),
        trial,
        paying: sn.paying,
        pastDue: sn.pastDue,
        readOnly,
        churned: payers.filter((p) => p.churnedAt && p.churnedAt < end).length,
        payingMrr: round2(sn.mrr),
      });
    }
    return { states, evolution };
  }

  // --- Concentración ---------------------------------------------------------

  async concentration(): Promise<AdminConcentrationDto> {
    const [paying, settings] = await Promise.all([
      currentMrrByTenant(this.admin),
      this.admin.platformAlertSettings.findFirst({ select: { alertConcentrationPct: true } }),
    ]);
    const thresholdPct = settings?.alertConcentrationPct ?? 25;
    const rows = [...paying.values()].sort((a, b) => b.total - a.total);
    const totalMrr = rows.reduce((s, r) => s + r.total, 0);
    const shares = concentrationShares(rows.map((r) => r.total));
    const top10 = rows.slice(0, 10);
    const names = await this.tenantNames(top10.map((r) => r.tenantId));
    const share = (v: number) => (totalMrr > 0 ? round2((v / totalMrr) * 100) : 0);
    return {
      ...shares,
      totalMrr: round2(totalMrr),
      payingTenants: rows.length,
      thresholdPct,
      top: top10.map((r) => ({
        tenantId: r.tenantId,
        name: names.get(r.tenantId)?.name ?? '—',
        slug: names.get(r.tenantId)?.slug ?? '',
        mrr: r.total,
        sharePct: share(r.total),
      })),
      overThreshold: rows.filter((r) => share(r.total) > thresholdPct).length,
    };
  }

  // --- Series de ingresos ------------------------------------------------------

  async revenueSeries(by: string, months: number): Promise<AdminRevenueSeriesDto> {
    if (!(REVENUE_SERIES_BY as readonly string[]).includes(by)) {
      throw new BadRequestException({
        code: 'invalid_series',
        message: 'Elige plan, extra, forma de cobro o comercial',
      });
    }
    const kind = by as AdminRevenueSeriesBy;
    const now = new Date();
    const nowIdx = madridMonthIndex(now);
    const firstIdx = nowIdx - (months - 1);
    const idxs = Array.from({ length: months }, (_, i) => firstIdx + i);
    const base = {
      by: kind,
      labels: idxs.map(monthIndexLabel),
      months: idxs.map(monthIndexKey),
    };
    /** Series a partir de un mapa clave → (mes → valor), de más a menos. */
    const toSeries = (map: Map<string, Map<number, number>>, labelOf: (k: string) => string) =>
      [...map.entries()]
        .map(([key, m]) => ({
          key,
          label: labelOf(key),
          values: idxs.map((i) => round2(m.get(i) ?? 0)),
        }))
        .sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0));
    const add = (map: Map<string, Map<number, number>>, key: string, idx: number, v: number) => {
      const m = map.get(key) ?? new Map<number, number>();
      m.set(idx, (m.get(idx) ?? 0) + v);
      map.set(key, m);
    };

    if (kind === 'source') {
      const payments = await this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: [...COLLECTED_PAYMENT_STATUSES] },
          paidAt: { gte: monthIndexStart(firstIdx) },
          tenant: { billingExempt: false },
        },
        select: { paidAt: true, amount: true, refundedAmount: true, provider: true },
      });
      const map = new Map<string, Map<number, number>>();
      for (const s of Object.keys(SOURCE_LABELS)) map.set(s, new Map());
      for (const p of payments) {
        if (!p.paidAt) continue;
        add(map, financeSource(p.provider), madridMonthIndex(p.paidAt), netPaid(p));
      }
      return {
        ...base,
        basis: 'collected',
        series: toSeries(map, (k) => SOURCE_LABELS[k as keyof typeof SOURCE_LABELS] ?? k),
        note: 'Cobrado neto (con IVA), por el mes en que se cobró.',
      };
    }

    // Meses cerrados: snapshots. Mes en curso: el MRR de ahora (el snapshot se
    // refresca una vez al día).
    const [pastSnapshots, live] = await Promise.all([
      this.admin.mrrSnapshot.findMany({
        where: {
          month: { gte: monthIndexDate(firstIdx), lt: monthIndexDate(nowIdx) },
          mrr: { gt: 0 },
        },
        select: { tenantId: true, month: true, planSlug: true, mrr: true },
      }),
      currentMrrByTenant(this.admin),
    ]);
    const snapshots = [
      ...pastSnapshots.map((sn) => ({
        tenantId: sn.tenantId,
        idx: dateMonthIndex(sn.month),
        planSlug: sn.planSlug,
        mrr: Number(sn.mrr),
      })),
      ...[...live.values()].map((p) => ({
        tenantId: p.tenantId,
        idx: nowIdx,
        planSlug: p.planSlug,
        mrr: p.total,
      })),
    ];

    if (kind === 'plan') {
      const plans = await this.admin.subscriptionPlan.findMany({
        select: { slug: true, name: true },
      });
      const nameBy = new Map(plans.map((p) => [p.slug, p.name]));
      const map = new Map<string, Map<number, number>>();
      for (const sn of snapshots) add(map, sn.planSlug, sn.idx, sn.mrr);
      return {
        ...base,
        basis: 'mrr',
        series: toSeries(map, (k) => nameBy.get(k) ?? k),
        note: 'MRR sin IVA al cierre de cada mes (plan y extras de cada cliente).',
      };
    }

    if (kind === 'addon') {
      const payingIn = new Set(snapshots.map((sn) => `${sn.tenantId}:${sn.idx}`));
      const [addons, pricing] = await Promise.all([
        this.admin.tenantSubscriptionAddon.findMany({
          where: { tenant: { billingExempt: false } },
          select: {
            tenantId: true,
            priceMonthly: true,
            quantity: true,
            createdAt: true,
            suspendedAt: true,
            addon: { select: { slug: true, name: true } },
          },
        }),
        platformPricing(this.admin),
      ]);
      const map = new Map<string, Map<number, number>>();
      const nameBy = new Map<string, string>();
      for (const a of addons) {
        nameBy.set(a.addon.slug, a.addon.name);
        for (const idx of idxs) {
          const end = idx === nowIdx ? now : monthIndexStart(idx + 1);
          if (a.createdAt >= end) continue;
          if (a.suspendedAt && a.suspendedAt < end) continue;
          if (!payingIn.has(`${a.tenantId}:${idx}`)) continue;
          add(
            map,
            a.addon.slug,
            idx,
            listPriceWithoutVat(Number(a.priceMonthly) * a.quantity, pricing),
          );
        }
      }
      return {
        ...base,
        basis: 'mrr',
        series: toSeries(map, (k) => nameBy.get(k) ?? k),
        note: 'MRR sin IVA de los extras de quien paga ese mes. Los extras quitados ya no salen.',
      };
    }

    // Por comercial: el que tenía asignado el cliente ese mes.
    const tenantIds = [...new Set(snapshots.map((s) => s.tenantId))];
    const [assignments, tenantReps] = await Promise.all([
      tenantIds.length > 0
        ? this.admin.salesAssignment.findMany({
            where: { tenantId: { in: tenantIds } },
            select: { tenantId: true, repId: true, startedAt: true, endedAt: true },
            orderBy: { startedAt: 'asc' },
          })
        : [],
      tenantIds.length > 0
        ? this.admin.tenant.findMany({
            where: { id: { in: tenantIds } },
            select: { id: true, salesRepId: true },
          })
        : [],
    ]);
    const assignBy = new Map<string, typeof assignments>();
    for (const a of assignments) {
      if (!a.tenantId) continue;
      const list = assignBy.get(a.tenantId) ?? [];
      list.push(a);
      assignBy.set(a.tenantId, list);
    }
    const currentRep = new Map(tenantReps.map((t) => [t.id, t.salesRepId]));
    const repAt = (tenantId: string, idx: number): string | null => {
      const list = assignBy.get(tenantId);
      if (!list) return currentRep.get(tenantId) ?? null;
      const start = monthIndexStart(idx);
      const end = idx === nowIdx ? new Date() : monthIndexStart(idx + 1);
      let rep: string | null = null;
      for (const a of list) {
        if (a.startedAt < end && (!a.endedAt || a.endedAt >= start)) rep = a.repId;
      }
      return rep;
    };
    const map = new Map<string, Map<number, number>>();
    for (const sn of snapshots) add(map, repAt(sn.tenantId, sn.idx) ?? 'none', sn.idx, sn.mrr);
    const repIds = [...map.keys()].filter((k) => k !== 'none');
    const reps =
      repIds.length > 0
        ? await this.admin.superAdmin.findMany({
            where: { id: { in: repIds } },
            select: { id: true, fullName: true },
          })
        : [];
    const repName = new Map(reps.map((r) => [r.id, r.fullName]));
    return {
      ...base,
      basis: 'mrr',
      series: toSeries(map, (k) => (k === 'none' ? 'Sin comercial' : (repName.get(k) ?? '—'))),
      note: 'MRR sin IVA al cierre de cada mes, según el comercial que llevaba al cliente.',
    };
  }

  // --- Desglose de una cifra -------------------------------------------------

  async breakdown(args: {
    metric: string;
    month?: string;
    plan?: string;
    kind?: string;
  }): Promise<AdminBreakdownDto> {
    if (!(BREAKDOWN_METRICS as readonly string[]).includes(args.metric)) {
      throw new BadRequestException({ code: 'invalid_metric', message: 'Cifra desconocida' });
    }
    const metric = args.metric as AdminBreakdownMetric;
    const now = new Date();
    const nowIdx = madridMonthIndex(now);
    const idx = monthParamIndex(args.month, nowIdx);
    const start = monthIndexStart(idx);
    const end = idx === nowIdx ? now : monthIndexStart(idx + 1);
    const monthText = monthIndexLabel(idx);

    const paying = await currentMrrByTenant(this.admin);
    const lines: { tenantId: string; mrr: number; detail: string | null }[] = [];
    let title = '';

    const STATE_METRICS: Partial<Record<AdminBreakdownMetric, TenantMetricsState>> = {
      active: 'active',
      trial: 'trial',
      past_due: 'past_due',
      read_only: 'read_only',
      suspended: 'suspended',
      cancelled: 'cancelled',
    };
    const STATE_TITLES: Record<TenantMetricsState, string> = {
      active: 'Activos',
      trial: CLIENT_STATE_LABELS.trial,
      past_due: CLIENT_STATE_LABELS.past_due,
      read_only: CLIENT_STATE_LABELS.read_only,
      suspended: 'Suspendidos',
      cancelled: 'Cancelados',
    };

    const state = STATE_METRICS[metric];
    if (state || metric === 'free') {
      const tenants = await this.admin.tenant.findMany({
        where: { billingExempt: false, deletedAt: null },
        select: {
          id: true,
          status: true,
          createdAt: true,
          trialEndsAt: true,
          subscription: { select: { status: true } },
        },
      });
      title = state ? STATE_TITLES[state] : CLIENT_STATE_LABELS.free;
      // Quien pagó y quedó en solo lectura es una baja, no una prueba sin pagar.
      const payerIds =
        metric === 'read_only'
          ? new Set((await loadPayerLifecycles(this.admin, now)).map((p) => p.tenantId))
          : null;
      for (const t of tenants) {
        const s = tenantMetricsState(t.status, t.subscription?.status);
        const p = paying.get(t.id);
        if (metric === 'free' ? s !== 'active' || p : s !== state) continue;
        if (payerIds?.has(t.id)) continue;
        lines.push({
          tenantId: t.id,
          mrr: p?.total ?? 0,
          detail:
            s === 'trial' && t.trialEndsAt
              ? `La prueba acaba el ${dayText(t.trialEndsAt)}`
              : `Alta el ${dayText(t.createdAt)}`,
        });
      }
    } else if (metric === 'paying' || metric === 'concentration' || metric === 'plan') {
      title = metric === 'concentration' ? 'Clientes por peso en el MRR' : 'Clientes que pagan';
      const total = [...paying.values()].reduce((s, p) => s + p.total, 0);
      for (const p of paying.values()) {
        if (metric === 'plan' && p.planSlug !== args.plan) continue;
        lines.push({
          tenantId: p.tenantId,
          mrr: p.total,
          detail:
            metric === 'concentration' && total > 0
              ? `${String(round2((p.total / total) * 100)).replace('.', ',')} % del MRR`
              : p.subscriptionStatus === 'past_due'
                ? 'Pago atrasado'
                : p.cycle === 'yearly'
                  ? 'Paga por años'
                  : null,
        });
      }
      if (metric === 'plan') {
        const plan = await this.admin.subscriptionPlan.findUnique({
          where: { slug: args.plan ?? '' },
          select: { name: true },
        });
        title = `Clientes del plan ${plan?.name ?? args.plan ?? ''}`.trim();
      }
    } else if (metric === 'signups') {
      title = `Altas de ${monthText}`;
      const tenants = await this.admin.tenant.findMany({
        where: { billingExempt: false, createdAt: { gte: start, lt: end } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const t of tenants) {
        lines.push({
          tenantId: t.id,
          mrr: paying.get(t.id)?.total ?? 0,
          detail: `Alta el ${dayText(t.createdAt)}`,
        });
      }
    } else if (metric === 'churned') {
      // Sin mes: todas las bajas (la tarjeta «De baja»); con mes, las de ese mes.
      title = args.month ? `Bajas de ${monthText}` : 'Clientes de baja';
      const payers = await loadPayerLifecycles(this.admin, now);
      for (const p of payers) {
        if (args.month ? !churnedBetween(p, start, end) : !p.churnedAt) continue;
        lines.push({
          tenantId: p.tenantId,
          mrr: p.lastMrr,
          detail: `Baja el ${dayText(p.churnedAt!)}${p.churnReason ? ` · ${p.churnReason}` : ''}`,
        });
      }
    } else if (metric === 'cohort') {
      title = `Clientes dados de alta en ${monthText}`;
      const payers = await loadPayerLifecycles(this.admin, now);
      for (const p of payers) {
        if (madridMonthIndex(p.createdAt) !== idx) continue;
        lines.push({
          tenantId: p.tenantId,
          mrr: p.churnedAt ? p.lastMrr : (paying.get(p.tenantId)?.total ?? p.lastMrr),
          detail: p.churnedAt
            ? `Baja el ${dayText(p.churnedAt)}`
            : `Paga desde el ${dayText(p.firstPaidAt)}`,
        });
      }
    } else {
      // movement
      const kind = args.kind as AdminMrrMovementKind;
      if (!(MRR_MOVEMENT_KINDS as readonly string[]).includes(kind ?? '')) {
        throw new BadRequestException({
          code: 'invalid_kind',
          message: 'Tipo de movimiento desconocido',
        });
      }
      title = `${MOVEMENT_LABELS[kind]} de ${monthText}`;
      for (const l of await this.movementLines(idx, kind)) lines.push(l);
    }

    const names = await this.tenantNames(lines.map((l) => l.tenantId));
    const rows: AdminBreakdownRowDto[] = lines
      .filter((l) => names.has(l.tenantId))
      .map((l) => {
        const t = names.get(l.tenantId)!;
        return {
          tenantId: l.tenantId,
          name: t.name,
          slug: t.slug,
          status: t.status,
          planName: t.planName,
          mrr: round2(l.mrr),
          detail: l.detail,
        };
      })
      .sort((a, b) => b.mrr - a.mrr || a.name.localeCompare(b.name, 'es'));
    return {
      metric,
      title,
      rows,
      totalMrr: round2(rows.reduce((s, r) => s + r.mrr, 0)),
    };
  }

  /** Tenants que forman un tipo de movimiento de MRR de un mes (snapshots). */
  private async movementLines(
    idx: number,
    kind: AdminMrrMovementKind,
  ): Promise<{ tenantId: string; mrr: number; detail: string | null }[]> {
    await this.mrr.ensureCurrentMonthSnapshot(new Date());
    const [prevRows, curRows, seenBefore] = await Promise.all([
      this.admin.mrrSnapshot.findMany({
        where: { month: monthIndexDate(idx - 1) },
        select: { tenantId: true, mrr: true },
      }),
      this.admin.mrrSnapshot.findMany({
        where: { month: monthIndexDate(idx) },
        select: { tenantId: true, mrr: true },
      }),
      this.admin.mrrSnapshot.findMany({
        where: { month: { lt: monthIndexDate(idx - 1) }, mrr: { gt: 0 } },
        select: { tenantId: true },
        distinct: ['tenantId'],
      }),
    ]);
    const before = new Map(prevRows.map((r) => [r.tenantId, Number(r.mrr)]));
    const after = new Map(curRows.map((r) => [r.tenantId, Number(r.mrr)]));
    const everSeen = new Set(seenBefore.map((s) => s.tenantId));
    const out: { tenantId: string; mrr: number; detail: string | null }[] = [];
    const eur = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;
    for (const t of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(t) ?? 0;
      const a = after.get(t) ?? 0;
      let k: AdminMrrMovementKind | null = null;
      if (b === 0 && a > 0) k = everSeen.has(t) ? 'reactivation' : 'new';
      else if (b > 0 && a === 0) k = 'churn';
      else if (a > b) k = 'expansion';
      else if (a < b) k = 'contraction';
      if (k !== kind) continue;
      out.push({
        tenantId: t,
        mrr: k === 'churn' ? b : k === 'new' || k === 'reactivation' ? a : Math.abs(a - b),
        detail: b > 0 && a > 0 ? `De ${eur(b)} a ${eur(a)}` : null,
      });
    }
    return out;
  }

  private async tenantNames(ids: string[]) {
    if (ids.length === 0) {
      return new Map<
        string,
        { name: string; slug: string; status: string; planName: string | null }
      >();
    }
    const rows = await this.admin.tenant.findMany({
      where: { id: { in: [...new Set(ids)] }, billingExempt: false },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        subscription: { select: { status: true, plan: { select: { name: true } } } },
      },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: r.name,
          slug: r.slug,
          status: tenantMetricsState(r.status, r.subscription?.status),
          planName: r.subscription?.plan.name ?? null,
        },
      ]),
    );
  }

  // --- Anotaciones -------------------------------------------------------------

  private toAnnotation(r: {
    id: string;
    date: Date;
    text: string;
    createdAt: Date;
    author: { fullName: string } | null;
  }): AdminMetricAnnotationDto {
    const date = r.date.toISOString().slice(0, 10);
    return {
      id: r.id,
      date,
      month: date.slice(0, 7),
      text: r.text,
      authorName: r.author?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private readonly annotationSelect = {
    id: true,
    date: true,
    text: true,
    createdAt: true,
    author: { select: { fullName: true } },
  } as const;

  async listAnnotations(): Promise<AdminMetricAnnotationDto[]> {
    const rows = await this.admin.platformMetricAnnotation.findMany({
      orderBy: { date: 'asc' },
      select: this.annotationSelect,
      take: 500,
    });
    return rows.map((r) => this.toAnnotation(r));
  }

  async createAnnotation(
    input: CreateMetricAnnotationInput,
    authorId: string,
  ): Promise<AdminMetricAnnotationDto> {
    const row = await this.admin.platformMetricAnnotation.create({
      data: { date: new Date(`${input.date}T00:00:00Z`), text: input.text, authorId },
      select: this.annotationSelect,
    });
    return this.toAnnotation(row);
  }

  async updateAnnotation(
    id: string,
    input: UpdateMetricAnnotationInput,
  ): Promise<AdminMetricAnnotationDto> {
    await this.findAnnotation(id);
    const row = await this.admin.platformMetricAnnotation.update({
      where: { id },
      data: {
        ...(input.date ? { date: new Date(`${input.date}T00:00:00Z`) } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
      },
      select: this.annotationSelect,
    });
    return this.toAnnotation(row);
  }

  async deleteAnnotation(id: string): Promise<void> {
    await this.findAnnotation(id);
    await this.admin.platformMetricAnnotation.delete({ where: { id } });
  }

  private async findAnnotation(id: string): Promise<void> {
    const row = await this.admin.platformMetricAnnotation.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'annotation_not_found',
        message: 'La anotación no existe',
      });
    }
  }
}
