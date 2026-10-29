import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MONTH_PARAM_REGEX } from '@storageos/shared';

import { TtlCache } from '../../common/cache/ttl-cache';
import { loadPuppeteer } from '../../common/puppeteer';
import {
  CHURNED_STATUSES,
  churnDate,
  churnedBetweenWhere,
  isLiveTenantStatus,
  netPaid,
} from '../../common/saas-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminMetricsService } from './admin-metrics.service';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsageService } from './admin-usage.service';
import { MrrSnapshotService } from './mrr-snapshot.service';

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

const startOfMonthUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonthsUtc = (d: Date, n: number) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const monthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthLabel = (d: Date) =>
  `${MONTHS_ES[d.getUTCMonth()]} ${String(d.getUTCFullYear() % 100).padStart(2, '0')}`;
const eur = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
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
    const nowMonth = startOfMonthUtc(new Date());
    const first = addMonthsUtc(nowMonth, -(span - 1));
    const tenants = await this.admin.tenant.findMany({
      where: { billingExempt: false, createdAt: { gte: first } },
      select: {
        id: true,
        createdAt: true,
        status: true,
        trialEndedAt: true,
        subscription: { select: { status: true, plan: { select: { priceMonthly: true } } } },
      },
    });
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
    const byMonth = new Map<string, AdminTrialFunnelStepsDto & { daysToPay: number[] }>();
    const totals = { ...empty(), daysToPay: [] as number[] };
    for (const t of tenants) {
      const key = monthKey(t.createdAt);
      const c = byMonth.get(key) ?? { ...empty(), daysToPay: [] };
      const step = this.trialOutcome(t);
      for (const target of [c, totals]) {
        target.signups += 1;
        if (activated.has(t.id)) target.activated += 1;
        target[step] += 1;
        if (step === 'converted' && t.trialEndedAt) {
          target.daysToPay.push((t.trialEndedAt.getTime() - t.createdAt.getTime()) / DAY);
        }
      }
      byMonth.set(key, c);
    }

    const finish = (s: AdminTrialFunnelStepsDto & { daysToPay: number[] }) => {
      const ended = s.signups - s.inTrial;
      const { daysToPay, ...steps } = s;
      return {
        steps,
        conversionPct: ended > 0 ? round2((s.converted / ended) * 100) : null,
        avgDaysToPay:
          daysToPay.length > 0
            ? Math.round(daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length)
            : null,
      };
    };

    const cohorts: AdminTrialFunnelCohortDto[] = [];
    for (let i = 0; i < span; i++) {
      const m = addMonthsUtc(first, i);
      const c = finish(byMonth.get(monthKey(m)) ?? { ...empty(), daysToPay: [] });
      cohorts.push({
        cohort: monthLabel(m),
        month: monthKey(m),
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

  private trialOutcome(t: {
    status: string;
    subscription: { status: string; plan: { priceMonthly: unknown } } | null;
  }): 'converted' | 'toFree' | 'churned' | 'inTrial' {
    if (t.status === 'trial') return 'inTrial';
    if ((CHURNED_STATUSES as readonly string[]).includes(t.status)) return 'churned';
    if (t.subscription?.status === 'active' && Number(t.subscription.plan.priceMonthly) > 0) {
      return 'converted';
    }
    return 'toFree';
  }

  // --- Objetivos -----------------------------------------------------------

  async getGoals(): Promise<AdminBusinessGoalsDto> {
    const [row, overview, funnel] = await Promise.all([
      this.admin.platformBusinessGoals.findFirst(),
      this.metrics.getOverview(),
      this.trialFunnel(3),
    ]);
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
      progress: {
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

    const [movements, overview, health, usage, currentMrr] = await Promise.all([
      this.mrr.getMovements(2),
      this.metrics.getOverview(),
      this.tenants.getTenantsHealth(),
      this.usage.getUsage(7),
      this.admin.mrrSnapshot.findMany({
        where: { month: startOfMonthUtc(new Date()) },
        select: { tenantId: true, mrr: true },
      }),
    ]);
    const alerts: AdminBusinessAlertDto[] = [];

    const [prev, cur] = movements.months.slice(-2);
    if (prev && cur && prev.endingMrr > 0) {
      const drop = ((prev.endingMrr - cur.endingMrr) / prev.endingMrr) * 100;
      if (drop >= settings.mrrDropPct) {
        alerts.push({
          kind: 'mrr_drop',
          title: `El MRR ha bajado un ${Math.round(drop)} %`,
          detail: `De ${eur(prev.endingMrr)} a ${eur(cur.endingMrr)} frente al mes pasado.`,
          tenantId: null,
        });
      }
    }
    if (overview.churnRatePercent >= settings.churnPct) {
      alerts.push({
        kind: 'churn',
        title: `Churn del mes: ${overview.churnRatePercent.toFixed(1)} %`,
        detail: `${overview.cancellationsThisMonth} baja(s) este mes (umbral ${settings.churnPct} %).`,
        tenantId: null,
      });
    }
    const mrrBy = new Map(currentMrr.map((r) => [r.tenantId, Number(r.mrr)]));
    for (const h of health) {
      const mrr = mrrBy.get(h.tenantId) ?? 0;
      if (mrr < settings.bigTenantMrr || mrr <= 0) continue;
      if (h.level !== 'at_risk' && h.level !== 'dormant') continue;
      alerts.push({
        kind: 'big_tenant_at_risk',
        title: `${h.name} (${eur(mrr)}/mes) está ${h.level === 'dormant' ? 'dormido' : 'en riesgo'}`,
        detail: `Salud ${h.score}/100${h.trend !== null && h.trend < 0 ? ` (${h.trend} frente al mes pasado)` : ''}.`,
        tenantId: h.tenantId,
      });
    }
    for (const r of usage.rows) {
      if (settings.aiCostUsdWeek <= 0 || r.ai.costUsd < settings.aiCostUsdWeek) continue;
      alerts.push({
        kind: 'ai_cost',
        title: `${r.tenantName} ha gastado $${r.ai.costUsd.toFixed(2)} de IA en 7 días`,
        detail: `${r.ai.calls} llamadas con la IA de la plataforma (umbral $${settings.aiCostUsdWeek}).`,
        tenantId: r.tenantId,
      });
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
        createdAt: true,
        updatedAt: true,
        canceledAt: true,
        deletedAt: true,
        subscription: {
          select: { status: true, plan: { select: { name: true, priceMonthly: true } } },
        },
        subscriptionAddons: {
          where: { suspendedAt: null },
          select: { priceMonthly: true, quantity: true },
        },
      },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    const since = addMonthsUtc(startOfMonthUtc(new Date()), -11);
    const [payments, health, usage, adoption, snapshots] = await Promise.all([
      this.admin.tenantSubscriptionPayment.findMany({
        where: { tenantId, status: { in: ['paid', 'partially_refunded', 'refunded'] } },
        select: { amount: true, refundedAmount: true, paidAt: true },
        orderBy: { paidAt: 'asc' },
      }),
      this.tenants.getTenantHealth(tenantId),
      this.usage.getUsage(30),
      this.tenants.getAdoption(),
      this.admin.mrrSnapshot.findMany({
        where: { tenantId, month: { gte: since } },
        select: { month: true, mrr: true },
      }),
    ]);

    const paying = tenant.subscription?.status === 'active' && isLiveTenantStatus(tenant.status);
    const plan = paying ? Number(tenant.subscription?.plan.priceMonthly ?? 0) : 0;
    const addons = paying
      ? tenant.subscriptionAddons.reduce((s, a) => s + Number(a.priceMonthly) * a.quantity, 0)
      : 0;
    const churned = (CHURNED_STATUSES as readonly string[]).includes(tenant.status);
    const end = churned ? churnDate(tenant) : new Date();
    const lifespanMonths = Math.max(
      1,
      (end.getUTCFullYear() - tenant.createdAt.getUTCFullYear()) * 12 +
        (end.getUTCMonth() - tenant.createdAt.getUTCMonth()),
    );
    const u = usage.rows.find((r) => r.tenantId === tenantId);
    const a = adoption.tenants.find((t) => t.tenantId === tenantId);
    const snapBy = new Map(snapshots.map((s) => [monthKey(s.month), Number(s.mrr)]));
    const paidDates = payments.map((p) => p.paidAt).filter((d): d is Date => d !== null);

    return {
      tenantId,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      planName: tenant.subscription?.plan.name ?? null,
      paying,
      mrr: { plan: round2(plan), addons: round2(addons), total: round2(plan + addons) },
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
      mrrHistory: Array.from({ length: 12 }, (_, i) => {
        const m = addMonthsUtc(since, i);
        return { label: monthLabel(m), mrr: snapBy.get(monthKey(m)) ?? 0 };
      }),
    };
  }

  // --- Informe mensual -----------------------------------------------------

  async monthlyReport(month: string): Promise<AdminMonthlyReportDto> {
    if (!MONTH_PARAM_REGEX.test(month)) {
      throw new BadRequestException({ code: 'invalid_month', message: 'Mes AAAA-MM' });
    }
    const [y, m] = month.split('-').map(Number) as [number, number];
    const start = new Date(Date.UTC(y, m - 1, 1));
    const next = addMonthsUtc(start, 1);
    const prevMonth = addMonthsUtc(start, -1);

    const [snapPrev, snapCur, seenBefore, signups, cancellations, trials, payments, invoiced] =
      await Promise.all([
        this.admin.mrrSnapshot.findMany({
          where: { month: prevMonth },
          select: { tenantId: true, mrr: true },
        }),
        this.admin.mrrSnapshot.findMany({
          where: { month: start },
          select: { tenantId: true, mrr: true, tenant: { select: { name: true } } },
        }),
        this.admin.mrrSnapshot.findMany({
          where: { month: { lt: prevMonth } },
          select: { tenantId: true },
          distinct: ['tenantId'],
        }),
        this.admin.tenant.count({
          where: { billingExempt: false, createdAt: { gte: start, lt: next } },
        }),
        this.admin.tenant.count({ where: churnedBetweenWhere(start, next) }),
        this.admin.tenant.findMany({
          where: { billingExempt: false, trialEndedAt: { gte: start, lt: next } },
          select: {
            status: true,
            subscription: { select: { status: true, plan: { select: { priceMonthly: true } } } },
          },
        }),
        this.admin.tenantSubscriptionPayment.findMany({
          where: {
            status: { in: ['paid', 'partially_refunded', 'refunded'] },
            paidAt: { gte: start, lt: next },
          },
          select: { amount: true, refundedAmount: true },
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
      cancellations,
      trialsEnded: trials.length,
      trialsConverted: trials.filter((t) => this.trialOutcome(t) === 'converted').length,
      collected: round2(payments.reduce((s, p) => s + netPaid(p), 0)),
      refunded: round2(payments.reduce((s, p) => s + Number(p.refundedAmount), 0)),
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
      ['MRR al empezar el mes', eur(r.mrrStart)],
      ['MRR al acabar el mes', eur(r.mrrEnd)],
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
      ['Cobrado neto', eur(r.collected)],
      ['Devuelto', eur(r.refunded)],
      ['Facturado neto', eur(r.invoiced)],
    ];
  }

  monthlyReportCsv(r: AdminMonthlyReportDto): string {
    const lines = [
      ['Concepto', 'Valor'],
      ...this.reportRows(r),
      [],
      ['Tenants con más MRR', 'MRR'],
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
