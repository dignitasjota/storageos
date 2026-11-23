import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  DEFAULT_AI_MONTHLY_QUERY_LIMIT,
  effectiveFeaturesFromList,
  isAnomalous,
  linearForecast,
  resolvePlanFeatures,
  type AdminUsageEvolutionDto,
  type AdminUsageMonthDto,
  type TenantFeature,
  WEB_CHAT_AI_FEATURE,
} from '@storageos/shared';

import {
  aiCostUsd,
  aiModelPrice,
  isKnownAiModel,
  type AiModelPrice,
} from '../../common/ai-pricing';
import { currentMonth } from '../../common/format';
import {
  madridMonthIndex,
  monthIndexDate,
  monthIndexKey,
  monthIndexLabel,
  monthIndexStart,
  OWN_KEY_AI_FEATURES,
} from '../../common/saas-metrics';
import { liveOverrideWhere } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminFinanceInsightsService } from './admin-finance-insights.service';
import { PlatformHealthSettingsService } from './health-settings.service';

import type { Env } from '../../config/env.schema';
import type { AdminTenantUsageRowDto, AdminUsageDto } from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Uso de cada tenant para el super admin: correos que envía a sus inquilinos
 * (con rebotes y quejas de spam, porque la cuenta de envío es compartida),
 * consumo del asistente de IA (tokens y coste estimado) y almacenamiento.
 */
@Injectable()
export class AdminUsageService {
  private readonly inputPrice: number;
  private readonly outputPrice: number;

  constructor(
    private readonly admin: PrismaAdminService,
    config: ConfigService<Env, true>,
    private readonly finance: AdminFinanceInsightsService,
    private readonly healthSettings: PlatformHealthSettingsService,
  ) {
    this.inputPrice = config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true });
    this.outputPrice = config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true });
  }

  /** Uso de un solo tenant (para su ficha de negocio). null si no existe. */
  async getUsageForTenant(
    tenantId: string,
    days = 30,
    now = new Date(),
  ): Promise<AdminTenantUsageRowDto | null> {
    const r = await this.getUsage(days, now, tenantId);
    return r.rows[0] ?? null;
  }

  async getUsage(days = 30, now = new Date(), tenantId?: string): Promise<AdminUsageDto> {
    const period = parseUsageDays(days);
    const since = new Date(now.getTime() - period * DAY_MS);
    const scope = tenantId ? { tenantId } : {};

    const marginMonths = Math.min(Math.max(Math.ceil(period / 30), 1), 12);
    const [tenants, emailRows, complaintRows, aiRows, storageRows, whatsappRows] =
      await Promise.all([
        this.admin.tenant.findMany({
          where: { deletedAt: null, ...(tenantId ? { id: tenantId } : {}) },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            tags: true,
            salesRepId: true,
            salesRep: { select: { fullName: true } },
            subscription: { select: { plan: { select: { slug: true, name: true } } } },
          },
          orderBy: { name: 'asc' },
        }),
        this.admin.communication.groupBy({
          by: ['tenantId', 'status'],
          where: { ...scope, channel: 'email', createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.admin.emailSuppression.groupBy({
          by: ['tenantId'],
          where: {
            tenantId: tenantId ?? { not: null },
            scope: 'marketing',
            createdAt: { gte: since },
          },
          _count: { _all: true },
        }),
        this.admin.aiUsageEvent.groupBy({
          by: ['tenantId', 'feature', 'ownKey', 'model'],
          // Solo las llamadas al modelo (no las reservas de consulta del límite).
          where: { ...scope, createdAt: { gte: since }, countsAsQuery: false },
          _count: { _all: true },
          _sum: { inputTokens: true, outputTokens: true },
        }),
        this.admin.tenantStorageUsage.findMany({ where: scope }),
        this.admin.whatsappMessage.groupBy({
          by: ['tenantId'],
          where: { ...scope, createdAt: { gte: since } },
          _count: { _all: true },
        }),
      ]);
    const ids = tenants.map((t) => t.id);
    const [ai30, margins, anomalies] = await Promise.all([
      this.aiQuotas(ids, now),
      this.finance.tenantMargins(marginMonths),
      this.anomalies(tenantId ? [tenantId] : null, now),
    ]);
    const whatsapp = new Map(whatsappRows.map((r) => [r.tenantId, r._count._all]));

    const email = new Map<string, { sent: number; bounced: number; failed: number }>();
    for (const r of emailRows) {
      const e = email.get(r.tenantId) ?? { sent: 0, bounced: 0, failed: 0 };
      if (r.status === 'sent' || r.status === 'delivered') e.sent += r._count._all;
      if (r.status === 'bounced') e.bounced += r._count._all;
      if (r.status === 'failed') e.failed += r._count._all;
      email.set(r.tenantId, e);
    }
    const complaints = new Map(complaintRows.map((r) => [r.tenantId ?? '', r._count._all]));
    // Las llamadas con la clave propia del tenant no nos cuestan: se cuentan
    // aparte y no entran en el coste.
    // El coste se calcula con el precio de cada modelo (`ai-pricing.ts`).
    const ai = new Map<
      string,
      { calls: number; input: number; output: number; own: number; cost: number }
    >();
    const models = new Map<string, number>();
    const byModel = new Map<string, Map<string, { calls: number; cost: number }>>();
    for (const r of aiRows) {
      const a = ai.get(r.tenantId) ?? { calls: 0, input: 0, output: 0, own: 0, cost: 0 };
      if (r.ownKey || OWN_KEY_AI_FEATURES.includes(r.feature)) {
        a.own += r._count._all;
      } else {
        const input = r._sum.inputTokens ?? 0;
        const output = r._sum.outputTokens ?? 0;
        const cost = aiCostUsd(r.model, input, output, this.fallback);
        a.calls += r._count._all;
        a.input += input;
        a.output += output;
        a.cost += cost;
        models.set(r.model, (models.get(r.model) ?? 0) + r._count._all);
        const m = byModel.get(r.tenantId) ?? new Map<string, { calls: number; cost: number }>();
        const cur = m.get(r.model) ?? { calls: 0, cost: 0 };
        m.set(r.model, { calls: cur.calls + r._count._all, cost: cur.cost + cost });
        byModel.set(r.tenantId, m);
      }
      ai.set(r.tenantId, a);
    }
    const storage = new Map(storageRows.map((r) => [r.tenantId, r]));

    const rows: AdminTenantUsageRowDto[] = tenants.map((t) => {
      const e = email.get(t.id) ?? { sent: 0, bounced: 0, failed: 0 };
      const a = ai.get(t.id);
      const inputTokens = a?.input ?? 0;
      const outputTokens = a?.output ?? 0;
      const s = storage.get(t.id);
      const attempted = e.sent + e.bounced;
      return {
        tenantId: t.id,
        tenantName: t.name,
        tenantSlug: t.slug,
        email: {
          ...e,
          complaints: complaints.get(t.id) ?? 0,
          bounceRate: attempted > 0 ? Math.round((e.bounced / attempted) * 1000) / 10 : null,
        },
        ai: {
          calls: a?.calls ?? 0,
          inputTokens,
          outputTokens,
          costUsd: Math.round((a?.cost ?? 0) * 100) / 100,
          ownKeyCalls: a?.own ?? 0,
          ...(ai30.get(t.id) ?? { queriesThisMonth: 0, queryLimit: null, revenueMonthly: 0 }),
        },
        storage: {
          bytes: s ? Number(s.bytes) : 0,
          objects: s?.objects ?? 0,
          measuredAt: s?.measuredAt.toISOString() ?? null,
          byBucket: bucketBytes(s?.byBucket),
        },
        planSlug: t.subscription?.plan.slug ?? null,
        planName: t.subscription?.plan.name ?? null,
        status: t.status,
        tags: t.tags,
        salesRepId: t.salesRepId,
        salesRepName: t.salesRep?.fullName ?? null,
        whatsapp: { messages: whatsapp.get(t.id) ?? 0 },
        aiByModel: [...(byModel.get(t.id) ?? new Map<string, { calls: number; cost: number }>())]
          .map(([model, v]) => ({
            model,
            calls: v.calls,
            costUsd: Math.round(v.cost * 100) / 100,
          }))
          .sort((x, y) => y.costUsd - x.costUsd || y.calls - x.calls),
        margin: (() => {
          const m = margins.get(t.id);
          return m
            ? { revenue: m.revenue, costs: m.costs, margin: m.margin, marginPct: m.marginPct }
            : null;
        })(),
        anomalies: anomalies.get(t.id) ?? [],
      };
    });

    const storageMeasuredAt = storageRows.reduce<Date | null>(
      (max, r) => (!max || r.measuredAt > max ? r.measuredAt : max),
      null,
    );

    return {
      days: period,
      rows,
      totals: {
        emailsSent: rows.reduce((n, r) => n + r.email.sent, 0),
        aiCostUsd: Math.round(rows.reduce((n, r) => n + r.ai.costUsd, 0) * 100) / 100,
        aiRevenueMonthly: Math.round(rows.reduce((n, r) => n + r.ai.revenueMonthly, 0) * 100) / 100,
        storageBytes: rows.reduce((n, r) => n + r.storage.bytes, 0),
      },
      aiPricing: {
        inputPerMTokUsd: this.inputPrice,
        outputPerMTokUsd: this.outputPrice,
        models: [...models.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([model, calls]) => {
            const p = aiModelPrice(model, this.fallback);
            return { model, calls, known: isKnownAiModel(model), ...p };
          }),
      },
      storageMeasuredAt: storageMeasuredAt?.toISOString() ?? null,
      anomalyCount: rows.filter((r) => r.anomalies.length > 0).length,
      marginMonths,
    };
  }

  /**
   * Consumo anómalo de los últimos 30 días frente a la media de los 3 bloques
   * de 30 días anteriores (correos y coste de la IA) o de los 3 meses anteriores
   * medidos (almacenamiento): más de N veces la media y por encima del mínimo
   * (ajustes de Salud y Uso). Sin media (es nuevo), basta con pasar el mínimo.
   */
  async anomalies(
    tenantIds: string[] | null,
    now = new Date(),
  ): Promise<Map<string, { kind: 'emails' | 'ai' | 'storage'; detail: string }[]>> {
    const out = new Map<string, { kind: 'emails' | 'ai' | 'storage'; detail: string }[]>();
    if (tenantIds && tenantIds.length === 0) return out;
    const settings = await this.healthSettings.get();
    const s30 = new Date(now.getTime() - 30 * DAY_MS);
    const s120 = new Date(now.getTime() - 120 * DAY_MS);
    const scope = tenantIds ? Prisma.sql`AND tenant_id = ANY(${tenantIds}::uuid[])` : Prisma.empty;
    const nowIdx = madridMonthIndex(now);
    const [emails, aiRows, storageNow, storagePrev] = await Promise.all([
      this.admin.$queryRaw<{ tenant_id: string; cur: bigint; prev: bigint }[]>`
        SELECT tenant_id::text AS tenant_id,
               COUNT(*) FILTER (WHERE created_at >= ${s30}) AS cur,
               COUNT(*) FILTER (WHERE created_at < ${s30}) AS prev
        FROM communications
        WHERE channel = 'email' AND status IN ('sent', 'delivered')
          AND created_at >= ${s120} ${scope}
        GROUP BY 1`,
      this.admin.$queryRaw<
        { tenant_id: string; model: string; i0: bigint; o0: bigint; i1: bigint; o1: bigint }[]
      >`
        SELECT tenant_id::text AS tenant_id, model,
               COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= ${s30}), 0)::bigint AS i0,
               COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= ${s30}), 0)::bigint AS o0,
               COALESCE(SUM(input_tokens) FILTER (WHERE created_at < ${s30}), 0)::bigint AS i1,
               COALESCE(SUM(output_tokens) FILTER (WHERE created_at < ${s30}), 0)::bigint AS o1
        FROM ai_usage_events
        WHERE created_at >= ${s120} AND counts_as_query = false AND own_key = false
          AND NOT (feature = ANY(${OWN_KEY_AI_FEATURES})) ${scope}
        GROUP BY 1, 2`,
      this.admin.tenantStorageUsage.findMany({
        where: tenantIds ? { tenantId: { in: tenantIds } } : {},
        select: { tenantId: true, bytes: true },
      }),
      this.admin.tenantStorageUsageHistory.findMany({
        where: {
          ...(tenantIds ? { tenantId: { in: tenantIds } } : {}),
          month: { gte: monthIndexDate(nowIdx - 3), lt: monthIndexDate(nowIdx) },
        },
        select: { tenantId: true, bytes: true },
      }),
    ]);
    const add = (id: string, a: { kind: 'emails' | 'ai' | 'storage'; detail: string }) => {
      const list = out.get(id) ?? [];
      list.push(a);
      out.set(id, list);
    };
    const mult = settings.anomalyMultiplier;
    const num = (n: number) => Math.round(n).toLocaleString('es-ES');
    for (const r of emails) {
      const cur = Number(r.cur);
      const avg = Number(r.prev) / 3;
      if (isAnomalous(cur, avg, mult, settings.anomalyMinEmails)) {
        add(r.tenant_id, {
          kind: 'emails',
          detail:
            avg > 0
              ? `${num(cur)} correos en 30 días (su media: ${num(avg)} cada 30 días)`
              : `${num(cur)} correos en 30 días (no enviaba antes)`,
        });
      }
    }
    const aiBy = new Map<string, { cur: number; prev: number }>();
    for (const r of aiRows) {
      const a = aiBy.get(r.tenant_id) ?? { cur: 0, prev: 0 };
      a.cur += aiCostUsd(r.model, Number(r.i0), Number(r.o0), this.fallback);
      a.prev += aiCostUsd(r.model, Number(r.i1), Number(r.o1), this.fallback);
      aiBy.set(r.tenant_id, a);
    }
    const usd = (n: number) => `${n.toFixed(2).replace('.', ',')} $`;
    for (const [id, a] of aiBy) {
      const avg = a.prev / 3;
      if (isAnomalous(a.cur, avg, mult, settings.anomalyMinAiUsd)) {
        add(id, {
          kind: 'ai',
          detail:
            avg > 0
              ? `${usd(a.cur)} de IA en 30 días (su media: ${usd(avg)} cada 30 días)`
              : `${usd(a.cur)} de IA en 30 días (no la usaba antes)`,
        });
      }
    }
    const prevStorage = new Map<string, { sum: number; n: number }>();
    for (const r of storagePrev) {
      const p = prevStorage.get(r.tenantId) ?? { sum: 0, n: 0 };
      p.sum += Number(r.bytes);
      p.n += 1;
      prevStorage.set(r.tenantId, p);
    }
    const mb = (b: number) => b / (1024 * 1024);
    for (const r of storageNow) {
      const cur = mb(Number(r.bytes));
      const p = prevStorage.get(r.tenantId);
      // Sin meses anteriores medidos no se puede comparar: el almacenamiento no es «nuevo».
      if (!p || p.n === 0) continue;
      const avg = mb(p.sum / p.n);
      if (isAnomalous(cur, avg, mult, settings.anomalyMinStorageMb)) {
        add(r.tenantId, {
          kind: 'storage',
          detail: `${num(cur)} MB guardados (su media: ${num(avg)} MB los 3 meses anteriores)`,
        });
      }
    }
    return out;
  }

  /**
   * Evolución mensual del uso (correos, WhatsApp, IA y almacenamiento) de un
   * tenant o de todos, con la previsión del almacenamiento por tendencia lineal
   * (6 meses).
   */
  async evolution(
    tenantId: string | null,
    months = 12,
    now = new Date(),
  ): Promise<AdminUsageEvolutionDto> {
    const span = Math.min(Math.max(Math.trunc(months), 3), 24);
    const nowIdx = madridMonthIndex(now);
    const firstIdx = nowIdx - (span - 1);
    const from = monthIndexStart(firstIdx);
    const scope = tenantId ? Prisma.sql`AND tenant_id = ${tenantId}::uuid` : Prisma.empty;
    const [emails, whatsapp, aiRows, storage] = await Promise.all([
      this.admin.$queryRaw<{ m: string; n: bigint }[]>`
        SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS m, COUNT(*)::bigint AS n
        FROM communications
        WHERE channel = 'email' AND status IN ('sent', 'delivered') AND created_at >= ${from} ${scope}
        GROUP BY 1`,
      this.admin.$queryRaw<{ m: string; n: bigint }[]>`
        SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS m, COUNT(*)::bigint AS n
        FROM whatsapp_messages WHERE created_at >= ${from} ${scope}
        GROUP BY 1`,
      this.admin.$queryRaw<{ m: string; model: string; n: bigint; i: bigint; o: bigint }[]>`
        SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS m, model,
               COUNT(*)::bigint AS n,
               COALESCE(SUM(input_tokens), 0)::bigint AS i,
               COALESCE(SUM(output_tokens), 0)::bigint AS o
        FROM ai_usage_events
        WHERE created_at >= ${from} AND counts_as_query = false AND own_key = false
          AND NOT (feature = ANY(${OWN_KEY_AI_FEATURES})) ${scope}
        GROUP BY 1, 2`,
      this.admin.tenantStorageUsageHistory.groupBy({
        by: ['month'],
        where: {
          ...(tenantId ? { tenantId } : {}),
          month: { gte: monthIndexDate(firstIdx) },
        },
        _sum: { bytes: true },
      }),
    ]);
    const keyed = (rows: { m: string; n: bigint }[]) =>
      new Map(rows.map((r) => [r.m, Number(r.n)]));
    const emailBy = keyed(emails);
    const waBy = keyed(whatsapp);
    const aiBy = new Map<string, { calls: number; cost: number }>();
    for (const r of aiRows) {
      const a = aiBy.get(r.m) ?? { calls: 0, cost: 0 };
      a.calls += Number(r.n);
      a.cost += aiCostUsd(r.model, Number(r.i), Number(r.o), this.fallback);
      aiBy.set(r.m, a);
    }
    const storageBy = new Map(
      storage.map((r) => [
        `${r.month.getUTCFullYear()}-${String(r.month.getUTCMonth() + 1).padStart(2, '0')}`,
        Number(r._sum.bytes ?? 0),
      ]),
    );
    const monthsOut: AdminUsageMonthDto[] = Array.from({ length: span }, (_, i) => {
      const idx = firstIdx + i;
      const key = monthIndexKey(idx);
      const a = aiBy.get(key);
      return {
        month: key,
        label: monthIndexLabel(idx),
        emails: emailBy.get(key) ?? 0,
        whatsapp: waBy.get(key) ?? 0,
        aiCalls: a?.calls ?? 0,
        aiCostUsd: Math.round((a?.cost ?? 0) * 100) / 100,
        storageBytes: storageBy.has(key) ? storageBy.get(key)! : null,
      };
    });
    // Previsión con los últimos 6 meses medidos.
    const measured = monthsOut.filter((m) => m.storageBytes !== null).slice(-6);
    const series = measured.map((m) => m.storageBytes!);
    const ahead = linearForecast(series, 6);
    const storageForecast =
      series.length === 0
        ? []
        : ahead.map((bytes, i) => {
            const idx = nowIdx + 1 + i;
            return { month: monthIndexKey(idx), label: monthIndexLabel(idx), bytes };
          });
    const storageMonthlyGrowth =
      series.length >= 2
        ? Math.round((series[series.length - 1]! - series[0]!) / (series.length - 1))
        : null;
    return { tenantId, months: monthsOut, storageForecast, storageMonthlyGrowth };
  }

  /**
   * Por tenant: consultas del asistente del panel este mes (las de la IA de la
   * plataforma), su límite (null si no tiene el asistente) y lo que paga al mes
   * por la IA (el extra del asistente y los de consultas).
   */
  private async aiQuotas(
    tenantIds: string[],
    now: Date,
  ): Promise<
    Map<string, { queriesThisMonth: number; queryLimit: number | null; revenueMonthly: number }>
  > {
    const month = currentMonth(now);
    const [settings, tenants, overrides, addons, queries] = await Promise.all([
      this.admin.platformAiSettings.findFirst({
        select: { monthlyQueryLimit: true, planLimits: true },
      }),
      this.admin.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: {
          id: true,
          aiMonthlyLimit: true,
          subscription: { select: { plan: { select: { slug: true, tenantFeatures: true } } } },
        },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId: { in: tenantIds }, ...liveOverrideWhere(now) },
        select: { tenantId: true, feature: true, enabled: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: {
          tenantId: { in: tenantIds },
          suspendedAt: null,
          OR: [{ addon: { feature: 'ai_assistant' } }, { addon: { grantsAiQueries: { gt: 0 } } }],
        },
        select: {
          tenantId: true,
          priceMonthly: true,
          quantity: true,
          addon: { select: { grantsAiQueries: true } },
        },
      }),
      this.admin.aiUsageEvent.groupBy({
        by: ['tenantId'],
        // Las del chat de la web tienen su propio límite.
        where: {
          countsAsQuery: true,
          ownKey: false,
          feature: { not: WEB_CHAT_AI_FEATURE },
          createdAt: { gte: month.start },
        },
        _count: { _all: true },
      }),
    ]);
    const general = settings?.monthlyQueryLimit ?? DEFAULT_AI_MONTHLY_QUERY_LIMIT;
    const queriesBy = new Map(queries.map((q) => [q.tenantId, q._count._all]));
    const overridesBy = new Map<string, { feature: TenantFeature; enabled: boolean }[]>();
    for (const o of overrides) {
      const list = overridesBy.get(o.tenantId) ?? [];
      list.push({ feature: o.feature as TenantFeature, enabled: o.enabled });
      overridesBy.set(o.tenantId, list);
    }
    const extraBy = new Map<string, { queries: number; revenue: number }>();
    for (const a of addons) {
      const e = extraBy.get(a.tenantId) ?? { queries: 0, revenue: 0 };
      e.queries += (a.addon.grantsAiQueries ?? 0) * a.quantity;
      e.revenue += Number(a.priceMonthly) * a.quantity;
      extraBy.set(a.tenantId, e);
    }
    const result = new Map<
      string,
      { queriesThisMonth: number; queryLimit: number | null; revenueMonthly: number }
    >();
    for (const t of tenants) {
      const plan = t.subscription?.plan;
      const features = effectiveFeaturesFromList(
        plan ? resolvePlanFeatures(plan) : [],
        overridesBy.get(t.id) ?? [],
      );
      const extra = extraBy.get(t.id) ?? { queries: 0, revenue: 0 };
      result.set(t.id, {
        queriesThisMonth: queriesBy.get(t.id) ?? 0,
        queryLimit: features.includes('ai_assistant')
          ? (t.aiMonthlyLimit ??
              planBase(settings?.planLimits, t.subscription?.plan.slug, general)) + extra.queries
          : null,
        revenueMonthly: Math.round(extra.revenue * 100) / 100,
      });
    }
    return result;
  }

  private get fallback(): AiModelPrice {
    return { inputPerMTokUsd: this.inputPrice, outputPerMTokUsd: this.outputPrice };
  }
}

/**
 * Días del periodo de Uso: un número entre 1 y 365; cualquier otra cosa
 * (vacío, texto, NaN) vale 30. Más de 365 se queda en 365 (las consultas son
 * agrupaciones por tenant, así que un año sigue siendo barato).
 */
export function parseUsageDays(raw: unknown): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(Math.trunc(n), 365);
}

/** Bytes por bucket de una medición guardada (JSON). */
function bucketBytes(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/** El límite del plan si el panel le puso uno; si no, el general. */
function planBase(raw: unknown, slug: string | undefined, general: number): number {
  const v = slug && raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[slug] : null;
  return typeof v === 'number' ? v : general;
}
