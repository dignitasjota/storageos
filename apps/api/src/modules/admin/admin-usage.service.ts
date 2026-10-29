import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_AI_MONTHLY_QUERY_LIMIT,
  effectiveFeaturesFromList,
  resolvePlanFeatures,
  type TenantFeature,
} from '@storageos/shared';

import { currentMonth } from '../../common/format';
import { OWN_KEY_AI_FEATURES } from '../../common/saas-metrics';
import { liveOverrideWhere } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';

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
  ) {
    this.inputPrice = config.get('AI_COST_INPUT_PER_MTOK_USD', { infer: true });
    this.outputPrice = config.get('AI_COST_OUTPUT_PER_MTOK_USD', { infer: true });
  }

  async getUsage(days = 30, now = new Date()): Promise<AdminUsageDto> {
    const period = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const since = new Date(now.getTime() - period * DAY_MS);

    const [tenants, emailRows, complaintRows, aiRows, storageRows] = await Promise.all([
      this.admin.tenant.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.communication.groupBy({
        by: ['tenantId', 'status'],
        where: { channel: 'email', createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.admin.emailSuppression.groupBy({
        by: ['tenantId'],
        where: { tenantId: { not: null }, scope: 'marketing', createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.admin.aiUsageEvent.groupBy({
        by: ['tenantId', 'feature', 'ownKey'],
        // Solo las llamadas al modelo (no las reservas de consulta del límite).
        where: { createdAt: { gte: since }, countsAsQuery: false },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.admin.tenantStorageUsage.findMany(),
    ]);
    const ai30 = await this.aiQuotas(
      tenants.map((t) => t.id),
      now,
    );

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
    const ai = new Map<string, { calls: number; input: number; output: number; own: number }>();
    for (const r of aiRows) {
      const a = ai.get(r.tenantId) ?? { calls: 0, input: 0, output: 0, own: 0 };
      if (r.ownKey || OWN_KEY_AI_FEATURES.includes(r.feature)) {
        a.own += r._count._all;
      } else {
        a.calls += r._count._all;
        a.input += r._sum.inputTokens ?? 0;
        a.output += r._sum.outputTokens ?? 0;
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
          costUsd: this.cost(inputTokens, outputTokens),
          ownKeyCalls: a?.own ?? 0,
          ...(ai30.get(t.id) ?? { queriesThisMonth: 0, queryLimit: null, revenueMonthly: 0 }),
        },
        storage: {
          bytes: s ? Number(s.bytes) : 0,
          objects: s?.objects ?? 0,
          measuredAt: s?.measuredAt.toISOString() ?? null,
        },
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
      aiPricing: { inputPerMTokUsd: this.inputPrice, outputPerMTokUsd: this.outputPrice },
      storageMeasuredAt: storageMeasuredAt?.toISOString() ?? null,
    };
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
      this.admin.platformAiSettings.findFirst({ select: { monthlyQueryLimit: true } }),
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
        where: { countsAsQuery: true, ownKey: false, createdAt: { gte: month.start } },
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
          ? (t.aiMonthlyLimit ?? general + extra.queries)
          : null,
        revenueMonthly: Math.round(extra.revenue * 100) / 100,
      });
    }
    return result;
  }

  private cost(input: number, output: number): number {
    const usd = (input * this.inputPrice + output * this.outputPrice) / 1_000_000;
    return Math.round(usd * 100) / 100;
  }
}
