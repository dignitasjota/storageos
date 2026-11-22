import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MONTH_PARAM_REGEX } from '@storageos/shared';

import { TtlCache } from '../../common/cache/ttl-cache';
import { loadPuppeteer } from '../../common/puppeteer';
import {
  churnedBetween,
  COLLECTED_PAYMENT_STATUSES,
  currentMrrByTenant,
  dateMonthIndex,
  isChurnedStatus,
  isPayingSubscription,
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
  trialOutcome,
} from '../../common/saas-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminMetricsService } from './admin-metrics.service';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsageService } from './admin-usage.service';
import { MrrSnapshotService } from './mrr-snapshot.service';
import { TenantHealthService } from './tenant-health.service';

import type {
  AdminBusinessAlertDto,
  AdminBusinessAlertSettingsDto,
  AdminBusinessAlertsDto,
  AdminBusinessGoalsDto,
  AdminGoalProgressDto,
  AdminMonthlyReportDto,
  AdminTenantBusinessDto,
  AdminTrialFunnelCohortDto,
  AdminTrialFunnelDto,
  AdminTrialFunnelStepsDto,
  UpdateBusinessAlertSettingsInput,
  UpdateBusinessGoalsInput,
} from '@storageos/shared';

const DAY = 86_400_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const MONTHS_LONG_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «3.427,00 €» (en español, los miles de 4 cifras no se agrupan por defecto). */
const eur = (n: number) => {
  const [int, dec] = Math.abs(n).toFixed(2).split('.') as [string, string];
  return `${n < 0 ? '−' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec} €`;
};
const pctText = (n: number) => `${n.toFixed(1).replace('.', ',')} %`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const csvCell = (v: string | number) => {
  const s = typeof v === 'number' ? String(v).replace('.', ',') : v;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const pct = (current: number, target: number): AdminGoalProgressDto | null =>
  target > 0 ? { current, target, pct: round2((current / target) * 100) } : null;

/**
 * Apartado «Negocio» del panel super admin: embudo de pruebas, objetivos,
 * avisos de negocio, ficha de negocio de un tenant e informe mensual.
 */
@Injectable()
export class AdminBusinessService {
  private readonly funnelCache = new TtlCache<AdminTrialFunnelDto>();

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly metrics: AdminMetricsService,
    private readonly mrr: MrrSnapshotService,
    private readonly tenants: AdminTenantsService,
    private readonly usage: AdminUsageService,
    private readonly healthDaily: TenantHealthService,
  ) {}

  // --- Embudo de pruebas ---------------------------------------------------

  trialFunnel(months: number): Promise<AdminTrialFunnelDto> {
    const span = Math.min(Math.max(Math.trunc(months) || 12, 1), 24);
    return this.funnelCache.get(String(span), () => this.computeTrialFunnel(span));
  }

  /**
   * Por mes de alta: cuántos tenants empezaron la prueba, cuántos firmaron su
   * primer contrato y en qué acabaron (pagan, Free, de baja o siguen en prueba).
   * Cuenta también a los anonimizados.
   */
  private async computeTrialFunnel(span: number): Promise<AdminTrialFunnelDto> {
    const nowIdx = madridMonthIndex(new Date());
    const firstIdx = nowIdx - (span - 1);
    const [tenants, payers] = await Promise.all([
      this.admin.tenant.findMany({
        where: { billingExempt: false, createdAt: { gte: monthIndexStart(firstIdx) } },
        select: { id: true, createdAt: true, status: true, trialEndedAt: true },
      }),
      loadPayerLifecycles(this.admin),
    ]);
    const payerBy = new Map(payers.map((p) => [p.tenantId, p]));
    const ids = tenants.map((t) => t.id);
    const activatedRows =
      ids.length > 0
        ? await this.admin.contract.groupBy({
            by: ['tenantId'],
            where: { tenantId: { in: ids }, signedAt: { not: null } },
            _count: { _all: true },
          })
        : [];
    const activated = new Set(activatedRows.map((r) => r.tenantId));

    const empty = (): AdminTrialFunnelStepsDto => ({
      signups: 0,
      activated: 0,
      converted: 0,
      toFree: 0,
      churned: 0,
      inTrial: 0,
    });
    const byMonth = new Map<number, AdminTrialFunnelStepsDto & { daysToPay: number[] }>();
    const totals = { ...empty(), daysToPay: [] as number[] };
    for (const t of tenants) {
      const key = madridMonthIndex(t.createdAt);
      const c = byMonth.get(key) ?? { ...empty(), daysToPay: [] };
      const payer = payerBy.get(t.id);
      // Pagan también los que tienen el pago atrasado; sin pagar nunca no es baja.
      const step = trialOutcome(t, payer);
      for (const target of [c, totals]) {
        target.signups += 1;
        if (activated.has(t.id)) target.activated += 1;
        target[step] += 1;
        const paidAt = payer ? (t.trialEndedAt ?? payer.firstPaidAt) : null;
        if (step === 'converted' && paidAt) {
          target.daysToPay.push(Math.max(0, (paidAt.getTime() - t.createdAt.getTime()) / DAY));
        }
      }
      byMonth.set(key, c);
    }

    const finish = (s: AdminTrialFunnelStepsDto & { daysToPay: number[] }) => {
      const ended = s.signups - s.inTrial;
      const { daysToPay, ...steps } = s;
      return {
        steps,
        conversionPct: ended > 0 ? round2(((s.converted + s.churned) / ended) * 100) : null,
        avgDaysToPay:
          daysToPay.length > 0
            ? Math.round(daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length)
            : null,
      };
    };

    const cohorts: AdminTrialFunnelCohortDto[] = [];
    for (let idx = firstIdx; idx <= nowIdx; idx++) {
      const c = finish(byMonth.get(idx) ?? { ...empty(), daysToPay: [] });
      cohorts.push({
        cohort: monthIndexLabel(idx),
        month: monthIndexKey(idx),
        ...c.steps,
        conversionPct: c.conversionPct,
        avgDaysToPay: c.avgDaysToPay,
      });
    }
    const t = finish(totals);
    return {
      months: span,
      totals: t.steps,
      conversionPct: t.conversionPct,
      activationPct: totals.signups > 0 ? round2((totals.activated / totals.signups) * 100) : null,
      avgDaysToPay: t.avgDaysToPay,
      cohorts,
    };
  }

  // --- Objetivos -----------------------------------------------------------

  async getGoals(): Promise<AdminBusinessGoalsDto> {
    const monthStart = monthIndexStart(madridMonthIndex(new Date()));
    const [row, overview, funnel, collectedRows] = await Promise.all([
      this.admin.platformBusinessGoals.findFirst(),
      this.metrics.getOverview(),
      this.trialFunnel(3),
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          status: { in: [...COLLECTED_PAYMENT_STATUSES] },
          paidAt: { gte: monthStart },
          tenant: { billingExempt: false },
        },
        select: { amount: true, refundedAmount: true },
      }),
    ]);
    const collectedTarget =
      row?.collectedTargetMonthly != null ? Number(row.collectedTargetMonthly) : null;
    const collectedThisMonth = round2(collectedRows.reduce((s, p) => s + netPaid(p), 0));
    const mrrTarget = row?.mrrTarget != null ? Number(row.mrrTarget) : null;
    const current = overview.mrr.total;
    let mrrNeededPerMonth: number | null = null;
    if (mrrTarget !== null && row?.targetDate && mrrTarget > current) {
      const months = Math.max(
        1,
        (row.targetDate.getUTCFullYear() - new Date().getUTCFullYear()) * 12 +
          (row.targetDate.getUTCMonth() - new Date().getUTCMonth()),
      );
      mrrNeededPerMonth = round2((mrrTarget - current) / months);
    }
    return {
      mrrTarget,
      signupsTargetMonthly: row?.signupsTargetMonthly ?? null,
      trialConversionTargetPct: row?.trialConversionTargetPct ?? null,
      targetDate: row?.targetDate ? row.targetDate.toISOString().slice(0, 10) : null,
      collectedTargetMonthly: collectedTarget,
      progress: {
        collected: collectedTarget !== null ? pct(collectedThisMonth, collectedTarget) : null,
        mrr: mrrTarget !== null ? pct(current, mrrTarget) : null,
        signups:
          row?.signupsTargetMonthly != null
            ? pct(overview.signupsThisMonth, row.signupsTargetMonthly)
            : null,
        trialConversion:
          row?.trialConversionTargetPct != null && funnel.conversionPct !== null
            ? pct(funnel.conversionPct, row.trialConversionTargetPct)
            : null,
      },
      mrrNeededPerMonth,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async updateGoals(input: UpdateBusinessGoalsInput): Promise<AdminBusinessGoalsDto> {
    const data = {
      ...(input.mrrTarget !== undefined ? { mrrTarget: input.mrrTarget } : {}),
      ...(input.signupsTargetMonthly !== undefined
        ? { signupsTargetMonthly: input.signupsTargetMonthly }
        : {}),
      ...(input.trialConversionTargetPct !== undefined
        ? { trialConversionTargetPct: input.trialConversionTargetPct }
        : {}),
      ...(input.targetDate !== undefined
        ? { targetDate: input.targetDate ? new Date(`${input.targetDate}T00:00:00Z`) : null }
        : {}),
      ...(input.collectedTargetMonthly !== undefined
        ? { collectedTargetMonthly: input.collectedTargetMonthly }
        : {}),
    };
    const row = await this.admin.platformBusinessGoals.findFirst({ select: { id: true } });
    if (row) await this.admin.platformBusinessGoals.update({ where: { id: row.id }, data });
    else await this.admin.platformBusinessGoals.create({ data });
    return this.getGoals();
  }

  // --- Avisos de negocio ---------------------------------------------------

  private async alertSettingsRow() {
    const row = await this.admin.platformAlertSettings.findFirst();
    return row ?? this.admin.platformAlertSettings.create({ data: {} });
  }

  private toAlertSettings(
    r: Awaited<ReturnType<AdminBusinessService['alertSettingsRow']>>,
  ): AdminBusinessAlertSettingsDto {
    return {
      enabled: r.businessAlertsEnabled,
      mrrDropPct: r.alertMrrDropPct,
      churnPct: r.alertChurnPct,
      aiCostUsdWeek: Number(r.alertAiCostUsdWeek),
      bigTenantMrr: Number(r.alertBigTenantMrr),
      concentrationPct: r.alertConcentrationPct,
    };
  }

  async updateAlertSettings(
    input: UpdateBusinessAlertSettingsInput,
  ): Promise<AdminBusinessAlertsDto> {
    const row = await this.alertSettingsRow();
    await this.admin.platformAlertSettings.update({
      where: { id: row.id },
      data: {
        ...(input.enabled !== undefined ? { businessAlertsEnabled: input.enabled } : {}),
        ...(input.mrrDropPct !== undefined ? { alertMrrDropPct: input.mrrDropPct } : {}),
        ...(input.churnPct !== undefined ? { alertChurnPct: input.churnPct } : {}),
        ...(input.aiCostUsdWeek !== undefined ? { alertAiCostUsdWeek: input.aiCostUsdWeek } : {}),
        ...(input.bigTenantMrr !== undefined ? { alertBigTenantMrr: input.bigTenantMrr } : {}),
        ...(input.concentrationPct !== undefined
          ? { alertConcentrationPct: input.concentrationPct }
          : {}),
      },
    });
    return this.businessAlerts();
  }

  /**
   * Avisos de negocio: caída del MRR frente al mes pasado, churn del mes por
   * encima del umbral, tenants grandes en riesgo y gasto de IA de un tenant en
   * la última semana. Los usa el resumen semanal (correo y chat).
   */
  async businessAlerts(): Promise<AdminBusinessAlertsDto> {
    const settings = this.toAlertSettings(await this.alertSettingsRow());
    if (!settings.enabled) return { settings, alerts: [] };

    const [movements, overview, health, usage, currentMrr, payingNow, drops, anomalies] =
      await Promise.all([
        this.mrr.getMovements(2),
        this.metrics.getOverview(),
        this.tenants.getTenantsHealth(),
        this.usage.getUsage(7),
        this.admin.mrrSnapshot.findMany({
          where: { month: monthIndexDate(madridMonthIndex(new Date())) },
          select: { tenantId: true, mrr: true },
        }),
        currentMrrByTenant(this.admin),
        this.healthDaily.drops(),
        this.usage.anomalies(null),
      ]);
    const alerts: AdminBusinessAlertDto[] = [];
    // Un aviso por tenant y tipo, aunque el origen lo repita.
    const seen = new Set<string>();
    const push = (a: AdminBusinessAlertDto) => {
      const key = `${a.kind}:${a.tenantId ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      alerts.push(a);
    };

    const [prev, cur] = movements.months.slice(-2);
    if (prev && cur && prev.endingMrr > 0) {
      const drop = ((prev.endingMrr - cur.endingMrr) / prev.endingMrr) * 100;
      if (drop >= settings.mrrDropPct) {
        push({
          kind: 'mrr_drop',
          title: `El MRR ha bajado un ${Math.round(drop)} %`,
          detail: `De ${eur(prev.endingMrr)} a ${eur(cur.endingMrr)} frente al mes pasado (sin IVA).`,
          tenantId: null,
        });
      }
    }
    if (overview.churnRatePercent >= settings.churnPct) {
      const n = overview.cancellationsThisMonth;
      push({
        kind: 'churn',
        title: `Churn del mes: ${pctText(overview.churnRatePercent)}`,
        detail: `${n} ${n === 1 ? 'baja' : 'bajas'} este mes (umbral ${settings.churnPct} %).`,
        tenantId: null,
      });
    }
    const mrrBy = new Map(currentMrr.map((r) => [r.tenantId, Number(r.mrr)]));
    // Concentración: un solo cliente pesa más del umbral en el MRR de ahora.
    const totalMrr = [...payingNow.values()].reduce((sum, p) => sum + p.total, 0);
    if (totalMrr > 0 && payingNow.size > 1) {
      const big = [...payingNow.values()]
        .map((p) => ({ ...p, share: (p.total / totalMrr) * 100 }))
        .filter((p) => p.share > settings.concentrationPct)
        .sort((a, b) => b.share - a.share);
      const names =
        big.length > 0
          ? await this.admin.tenant.findMany({
              where: { id: { in: big.map((b) => b.tenantId) } },
              select: { id: true, name: true, slug: true },
            })
          : [];
      const nameBy = new Map(names.map((n) => [n.id, n]));
      for (const b of big) {
        const t = nameBy.get(b.tenantId);
        push({
          kind: 'concentration',
          title: `${t?.name ?? 'Un cliente'} (${t?.slug ?? '—'}) es el ${pctText(b.share)} del MRR`,
          detail: `Aporta ${eur(b.total)} de ${eur(totalMrr)} al mes sin IVA (umbral ${settings.concentrationPct} %).`,
          tenantId: b.tenantId,
        });
      }
    }
    for (const h of health) {
      const mrr = mrrBy.get(h.tenantId) ?? 0;
      if (mrr < settings.bigTenantMrr || mrr <= 0) continue;
      if (h.level !== 'at_risk' && h.level !== 'dormant') continue;
      push({
        kind: 'big_tenant_at_risk',
        title: `${h.name} (${h.slug}, ${eur(mrr)}/mes) está ${h.level === 'dormant' ? 'dormido' : 'en riesgo'}`,
        detail: `Salud ${h.score}/100${h.trend !== null && h.trend < 0 ? ` (${h.trend} frente al mes pasado)` : ''}.`,
        tenantId: h.tenantId,
      });
    }
    for (const r of usage.rows) {
      if (settings.aiCostUsdWeek <= 0 || r.ai.costUsd < settings.aiCostUsdWeek) continue;
      push({
        kind: 'ai_cost',
        title: `${r.tenantName} (${r.tenantSlug}) ha gastado ${r.ai.costUsd.toFixed(2).replace('.', ',')} $ de IA en 7 días`,
        detail: `${r.ai.calls} ${r.ai.calls === 1 ? 'llamada' : 'llamadas'} con la IA de la plataforma (umbral ${settings.aiCostUsdWeek} $).`,
        tenantId: r.tenantId,
      });
    }
    // Caídas de salud frente a la foto de hace una semana (ajustes de Salud).
    for (const d of drops) {
      push({
        kind: 'health_drop',
        title: `La salud de ${d.name} (${d.slug}) ha caído ${d.points} puntos`,
        detail: `De ${d.from} a ${d.to} sobre 100 desde el ${d.referenceDay}.`,
        tenantId: d.tenantId,
      });
    }
    // Consumo anómalo (correos, IA o almacenamiento) frente a su media.
    if (anomalies.size > 0) {
      const names = await this.admin.tenant.findMany({
        where: { id: { in: [...anomalies.keys()] }, deletedAt: null },
        select: { id: true, name: true, slug: true },
      });
      for (const n of names) {
        const list = anomalies.get(n.id) ?? [];
        push({
          kind: 'usage_anomaly',
          title: `Consumo anómalo de ${n.name} (${n.slug})`,
          detail: list.map((a) => a.detail).join(' · '),
          tenantId: n.id,
        });
      }
    }
    return { settings, alerts };
  }

  // --- Ficha de negocio del tenant -----------------------------------------

  async tenantBusiness(tenantId: string): Promise<AdminTenantBusinessDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        billingExempt: true,
        createdAt: true,
        updatedAt: true,
        canceledAt: true,
        deletedAt: true,
        subscription: { select: MRR_SUBSCRIPTION_SELECT },
      },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const nowIdx = madridMonthIndex(new Date());
    const sinceIdx = nowIdx - 11;
    const [payments, health, usage, adoption, snapshots, ctx, payers] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: { tenantId, status: { in: [...COLLECTED_PAYMENT_STATUSES] } },
        select: { amount: true, refundedAmount: true, paidAt: true },
        orderBy: { paidAt: 'asc' },
      }),
      this.tenants.getTenantHealth(tenantId),
      this.usage.getUsageForTenant(tenantId, 30),
      this.tenants.getAdoptionForTenant(tenantId),
      this.admin.mrrSnapshot.findMany({
        where: { tenantId, month: { gte: monthIndexDate(sinceIdx) } },
        select: { month: true, mrr: true },
      }),
      loadMrrContext(this.admin, [tenantId]),
      loadPayerLifecycles(this.admin),
    ]);

    const sub = tenant.subscription;
    const mrr = sub ? mrrFor(ctx, tenantId, sub) : { plan: 0, addons: 0, total: 0 };
    const paying = isPayingSubscription(sub, tenant) && mrr.total > 0;
    const churned = isChurnedStatus(tenant.status);
    const payer = payers.find((p) => p.tenantId === tenantId);
    const end =
      payer?.churnedAt ?? (churned ? (tenant.canceledAt ?? tenant.updatedAt) : new Date());
    const lifespanMonths = Math.max(1, madridMonthIndex(end) - madridMonthIndex(tenant.createdAt));
    const u = usage;
    const a = adoption;
    const snapBy = new Map(snapshots.map((s) => [dateMonthIndex(s.month), Number(s.mrr)]));
    const paidDates = payments.map((p) => p.paidAt).filter((d): d is Date => d !== null);

    return {
      tenantId,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      planName: sub?.plan.name ?? null,
      paying,
      mrr: paying
        ? { plan: mrr.plan, addons: mrr.addons, total: mrr.total }
        : { plan: 0, addons: 0, total: 0 },
      payments: {
        totalNet: round2(payments.reduce((s, p) => s + netPaid(p), 0)),
        refunded: round2(payments.reduce((s, p) => s + Number(p.refundedAmount), 0)),
        count: payments.length,
        firstPaidAt: paidDates[0]?.toISOString() ?? null,
        lastPaidAt: paidDates[paidDates.length - 1]?.toISOString() ?? null,
      },
      lifespanMonths,
      health,
      usage30d: {
        emailsSent: u?.email.sent ?? 0,
        bounceRate: u?.email.bounceRate ?? null,
        aiCalls: u?.ai.calls ?? 0,
        aiCostUsd: u?.ai.costUsd ?? 0,
        storageBytes: u?.storage.bytes ?? 0,
      },
      adoption: a
        ? {
            usedFeatures: a.features.filter((f) => f.used).map((f) => f.label),
            monthlyPaid: a.monthlyPaid,
            isCandidate: a.isCandidate,
            recommendedPlanName: a.recommendedPlanName,
          }
        : null,
      mrrHistory: Array.from({ length: 12 }, (_, i) => ({
        label: monthIndexLabel(sinceIdx + i),
        mrr: snapBy.get(sinceIdx + i) ?? 0,
      })),
    };
  }

  // --- Informe mensual -----------------------------------------------------

  async monthlyReport(month: string): Promise<AdminMonthlyReportDto> {
    if (!MONTH_PARAM_REGEX.test(month)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes AAAA-MM' });
    }
    const [y, m] = month.split('-').map(Number) as [number, number];
    const idx = y * 12 + (m - 1);
    if (idx > madridMonthIndex(new Date())) {
      throw new BadRequestException({
        code: 'month_in_future',
        message: 'Ese mes todavía no ha empezado.',
      });
    }
    // El mes en hora de España; los snapshots se guardan con el día 1.
    const start = monthIndexStart(idx);
    const next = monthIndexStart(idx + 1);

    const [snapPrev, snapCur, seenBefore, signups, payers, trials, payments, refunds, invoiced] =
      await Promise.all([
        this.admin.mrrSnapshot.findMany({
          where: { month: monthIndexDate(idx - 1) },
          select: { tenantId: true, mrr: true },
        }),
        this.admin.mrrSnapshot.findMany({
          where: { month: monthIndexDate(idx) },
          select: { tenantId: true, mrr: true, tenant: { select: { name: true } } },
        }),
        this.admin.mrrSnapshot.findMany({
          where: { month: { lt: monthIndexDate(idx - 1) }, mrr: { gt: 0 } },
          select: { tenantId: true },
          distinct: ['tenantId'],
        }),
        this.admin.tenant.count({
          where: { billingExempt: false, createdAt: { gte: start, lt: next } },
        }),
        loadPayerLifecycles(this.admin),
        this.admin.tenant.findMany({
          where: { billingExempt: false, trialEndedAt: { gte: start, lt: next } },
          select: { id: true, status: true },
        }),
        this.admin.tenantSubscriptionPayment.findMany({
          where: {
            status: { in: [...COLLECTED_PAYMENT_STATUSES] },
            paidAt: { gte: start, lt: next },
          },
          select: { amount: true, refundedAmount: true },
        }),
        // Devuelto en el mes, por la fecha de la devolución.
        this.admin.tenantSubscriptionPayment.aggregate({
          where: {
            refundedAmount: { gt: 0 },
            OR: [
              { refundedAt: { gte: start, lt: next } },
              { refundedAt: null, paidAt: { gte: start, lt: next } },
            ],
          },
          _sum: { refundedAmount: true },
        }),
        this.admin.platformInvoice.aggregate({
          where: { issuedAt: { gte: start, lt: next }, status: { not: 'rectified' } },
          _sum: { total: true },
        }),
      ]);

    const before = new Map(snapPrev.map((s) => [s.tenantId, Number(s.mrr)]));
    const after = new Map(snapCur.map((s) => [s.tenantId, Number(s.mrr)]));
    const everSeen = new Set(seenBefore.map((s) => s.tenantId));
    const mv = { newMrr: 0, expansion: 0, reactivation: 0, contraction: 0, churn: 0, net: 0 };
    for (const t of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(t) ?? 0;
      const a = after.get(t) ?? 0;
      if (b === 0 && a > 0) {
        if (everSeen.has(t)) mv.reactivation += a;
        else mv.newMrr += a;
      } else if (b > 0 && a === 0) mv.churn += b;
      else if (a > b) mv.expansion += a - b;
      else if (a < b) mv.contraction += b - a;
    }
    mv.net = mv.newMrr + mv.expansion + mv.reactivation - mv.contraction - mv.churn;
    const sum = (map: Map<string, number>) => [...map.values()].reduce((s, v) => s + v, 0);
    const payerBy = new Map(payers.map((p) => [p.tenantId, p]));

    return {
      month,
      label: `${MONTHS_LONG_ES[m - 1]} de ${y}`,
      mrrStart: round2(sum(before)),
      mrrEnd: round2(sum(after)),
      movements: {
        newMrr: round2(mv.newMrr),
        expansion: round2(mv.expansion),
        reactivation: round2(mv.reactivation),
        contraction: round2(mv.contraction),
        churn: round2(mv.churn),
        net: round2(mv.net),
      },
      signups,
      cancellations: payers.filter((p) => churnedBetween(p, start, next)).length,
      trialsEnded: trials.length,
      trialsConverted: trials.filter((t) => {
        const outcome = trialOutcome(t, payerBy.get(t.id));
        return outcome === 'converted' || outcome === 'churned';
      }).length,
      collected: round2(payments.reduce((s, p) => s + netPaid(p), 0)),
      refunded: round2(Number(refunds._sum.refundedAmount ?? 0)),
      invoiced: round2(Number(invoiced._sum.total ?? 0)),
      payingTenants: snapCur.filter((s) => Number(s.mrr) > 0).length,
      topTenants: snapCur
        .map((s) => ({ name: s.tenant.name, mrr: round2(Number(s.mrr)) }))
        .sort((a, b) => b.mrr - a.mrr)
        .slice(0, 10),
    };
  }

  /** Filas del informe (concepto, valor) para el CSV y el PDF. */
  private reportRows(r: AdminMonthlyReportDto): [string, string][] {
    return [
      ['MRR al empezar el mes (sin IVA)', eur(r.mrrStart)],
      ['MRR al acabar el mes (sin IVA)', eur(r.mrrEnd)],
      ['Nuevo', eur(r.movements.newMrr)],
      ['Expansión', eur(r.movements.expansion)],
      ['Reactivación', eur(r.movements.reactivation)],
      ['Contracción', eur(r.movements.contraction)],
      ['Bajas (MRR)', eur(r.movements.churn)],
      ['Variación neta', eur(r.movements.net)],
      ['Tenants que pagan', String(r.payingTenants)],
      ['Altas', String(r.signups)],
      ['Bajas', String(r.cancellations)],
      ['Pruebas terminadas', String(r.trialsEnded)],
      ['Pruebas que pasaron a pagar', String(r.trialsConverted)],
      ['Cobrado neto (con IVA)', eur(r.collected)],
      ['Devuelto en el mes (con IVA)', eur(r.refunded)],
      ['Facturado neto (con IVA)', eur(r.invoiced)],
    ];
  }

  monthlyReportCsv(r: AdminMonthlyReportDto): string {
    const lines = [
      ['Concepto', 'Valor'],
      ...this.reportRows(r),
      [],
      ['Tenants con más MRR', 'MRR (sin IVA)'],
      ...r.topTenants.map((t) => [t.name, eur(t.mrr)]),
    ];
    return `${String.fromCharCode(0xfeff)}${lines.map((l) => l.map(csvCell).join(';')).join('\n')}\n`;
  }

  async monthlyReportPdf(r: AdminMonthlyReportDto): Promise<Buffer> {
    const rows = this.reportRows(r)
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="n">${escapeHtml(v)}</td></tr>`)
      .join('');
    const top = r.topTenants
      .map(
        (t) =>
          `<tr><td>${escapeHtml(t.name)}</td><td class="n">${escapeHtml(eur(t.mrr))}</td></tr>`,
      )
      .join('');
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
body{font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#111;font-size:12px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px}
p.sub{color:#666;margin:0 0 16px}table{border-collapse:collapse;width:100%}
td{padding:6px 8px;border-bottom:1px solid #eee}td.n{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Informe del negocio · ${escapeHtml(r.label)}</h1>
<p class="sub">TrasterOS · plataforma</p>
<table>${rows}</table>
${top ? `<h2>Tenants con más MRR</h2><table>${top}</table>` : ''}
</body></html>`;
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}
