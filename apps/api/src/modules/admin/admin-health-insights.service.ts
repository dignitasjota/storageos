import { Injectable } from '@nestjs/common';
import {
  FEATURE_LABELS,
  resolvePlanFeatures,
  TenantFeatures,
  type AdminAdoptionInsightsDto,
  type AdminBulkFollowupsInput,
  type AdminBulkFollowupsResultDto,
  type AdminFeatureMatrixRowDto,
  type AdminFeatureRetentionDto,
  type AdminUpgradeCandidateDto,
  type AdminUpgradeCandidatesDto,
  type AdminUpgradeSuggestionDto,
  type TenantFeature,
  type UpgradeReasonKind,
} from '@storageos/shared';

import { listPriceWithoutVat, loadPayerLifecycles } from '../../common/saas-metrics';
import { platformPricing } from '../billing-saas/platform-pricing';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantsService } from './admin-tenants.service';
import { INTENSITY_UNITS, loadFeatureIntensity } from './adoption-intensity';
import { SuperAdminAuditService } from './super-admin-audit.service';

const DAY = 86_400_000;

/** Veces que el equipo debe entrar en una función que no tiene para contar como interés. */
export const INTEREST_MIN_VISITS = 2;

/** Mínimos para dar por buena la comparación de bajas por función. */
const RETENTION_MIN_GROUP = 5;
const RETENTION_MIN_CHURNED = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Lo que se añade a Adopción para vender y retener: candidatos unificados con
 * su ingreso extra estimado, matriz función × plan, bajas por función y
 * seguimientos en lote.
 */
@Injectable()
export class AdminHealthInsightsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  /**
   * Candidatos a subir de plan o contratar un extra: topan o se acercan (80 %)
   * a un límite, usan funciones fuera de su plan o han entrado varias veces en
   * una función que no tienen (30 días). Cada uno con la propuesta (plan o
   * extra) y el ingreso extra estimado al mes sin IVA.
   */
  async candidates(now = new Date()): Promise<AdminUpgradeCandidatesDto> {
    const since30 = new Date(now.getTime() - 30 * DAY);
    const since90 = new Date(now.getTime() - 90 * DAY);
    const [adoption, catalog, plans, pricing, interest, addonOffers, quoteOffers] =
      await Promise.all([
        this.tenants.getAdoption(),
        this.admin.subscriptionAddon.findMany({
          where: { isActive: true, isSystem: false },
          select: {
            id: true,
            slug: true,
            name: true,
            feature: true,
            priceMonthly: true,
            grantsUnits: true,
            grantsFacilities: true,
            grantsUsers: true,
          },
        }),
        this.admin.subscriptionPlan.findMany({ where: { isActive: true } }),
        platformPricing(this.admin),
        this.admin.featureInterestEvent.groupBy({
          by: ['tenantId', 'feature'],
          where: { createdAt: { gte: since30 } },
          _count: { _all: true },
        }),
        this.admin.superAdminAuditLog.findMany({
          where: { action: 'admin.saas_addon.proposed', occurredAt: { gte: since90 } },
          select: { targetTenantId: true, occurredAt: true },
        }),
        this.admin.platformQuoteOffer.findMany({
          where: { tenantId: { not: null }, createdAt: { gte: since90 } },
          select: { tenantId: true, createdAt: true },
        }),
      ]);
    const net = (price: number) => round2(listPriceWithoutVat(price, pricing));
    // Solo se proponen planes públicos; el precio actual sale de cualquier plan (también ocultos).
    const sortedPlans = plans
      .filter((p) => p.isPublic)
      .sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly));
    const lastOffer = new Map<string, Date>();
    const remember = (id: string | null, d: Date) => {
      if (!id) return;
      const prev = lastOffer.get(id);
      if (!prev || d > prev) lastOffer.set(id, d);
    };
    for (const o of addonOffers) remember(o.targetTenantId, o.occurredAt);
    for (const o of quoteOffers) remember(o.tenantId, o.createdAt);
    const interestBy = new Map<string, { feature: TenantFeature; n: number }[]>();
    for (const i of interest) {
      if (i._count._all < INTEREST_MIN_VISITS) continue;
      const list = interestBy.get(i.tenantId) ?? [];
      list.push({ feature: i.feature as TenantFeature, n: i._count._all });
      interestBy.set(i.tenantId, list);
    }

    const out: AdminUpgradeCandidateDto[] = [];
    for (const t of adoption.tenants) {
      const reasons: { kind: UpgradeReasonKind; detail: string }[] = [];
      const suggestions: AdminUpgradeSuggestionDto[] = [];
      const has = (ft: TenantFeature) => {
        const f = t.features.find((x) => x.feature === ft);
        return !!(f?.inPlan || f?.viaOverride);
      };
      const currentPlanPrice = t.planSlug
        ? net(Number(plans.find((p) => p.slug === t.planSlug)?.priceMonthly ?? 0))
        : 0;

      if (t.tapsLimit) reasons.push({ kind: 'taps_limit', detail: `Topa: ${t.limitDetail ?? ''}` });
      else if (t.nearLimit) {
        reasons.push({ kind: 'near_limit', detail: `Cerca del límite: ${t.limitDetail ?? ''}` });
      }
      if (t.usesFeatureOutsidePlan) {
        const names = t.features
          .filter((f) => f.used && !f.inPlan && !f.viaOverride)
          .map((f) => f.label);
        reasons.push({ kind: 'outside_plan', detail: `Usa sin tenerlo: ${names.join(', ')}` });
      }
      for (const i of interestBy.get(t.tenantId) ?? []) {
        if (!(TenantFeatures as readonly string[]).includes(i.feature) || has(i.feature)) continue;
        reasons.push({
          kind: 'interest',
          detail: `Ha entrado ${i.n} veces en ${FEATURE_LABELS[i.feature]} sin tenerla`,
        });
        const addon = catalog
          .filter((a) => a.feature === i.feature)
          .sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly))[0];
        if (addon) {
          suggestions.push({
            type: 'addon',
            id: addon.id,
            slug: addon.slug,
            name: addon.name,
            extraMonthly: net(Number(addon.priceMonthly)),
            trialable: true,
          });
        } else {
          const plan = sortedPlans.find((p) => resolvePlanFeatures(p).includes(i.feature));
          if (plan && net(Number(plan.priceMonthly)) > currentPlanPrice) {
            suggestions.push({
              type: 'plan',
              id: plan.id,
              slug: plan.slug,
              name: plan.name,
              extraMonthly: round2(net(Number(plan.priceMonthly)) - currentPlanPrice),
              trialable: false,
            });
          }
        }
      }
      if (reasons.length === 0) continue;

      // Plan recomendado por Adopción (usa más de lo que tiene o topa).
      if (t.isCandidate && t.recommendedPlanSlug && t.recommendedPlanPrice !== null) {
        const plan = plans.find((p) => p.slug === t.recommendedPlanSlug);
        if (plan) {
          suggestions.push({
            type: 'plan',
            id: plan.id,
            slug: plan.slug,
            name: plan.name,
            extraMonthly: round2(Math.max(0, t.recommendedPlanPrice - currentPlanPrice)),
            trialable: false,
          });
        }
      }
      // Cerca o en el límite sin plan recomendado: el extra de capacidad más barato.
      if ((t.tapsLimit || t.nearLimit) && !suggestions.some((s) => s.type === 'plan')) {
        const u = t.usage;
        const needUnits = u.maxUnits !== null && u.units >= u.maxUnits * 0.8;
        const needFacilities = u.maxFacilities !== null && u.facilities >= u.maxFacilities * 0.8;
        const needUsers = u.maxUsers !== null && u.users >= u.maxUsers * 0.8;
        const capacity = catalog
          .filter(
            (a) =>
              (needUnits && (a.grantsUnits ?? 0) > 0) ||
              (needFacilities && (a.grantsFacilities ?? 0) > 0) ||
              (needUsers && (a.grantsUsers ?? 0) > 0),
          )
          .sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly))[0];
        if (capacity) {
          suggestions.push({
            type: 'addon',
            id: capacity.id,
            slug: capacity.slug,
            name: capacity.name,
            extraMonthly: net(Number(capacity.priceMonthly)),
            trialable: false,
          });
        }
      }
      // Sin repetir la misma propuesta.
      const unique = suggestions.filter(
        (s, i) => suggestions.findIndex((x) => x.type === s.type && x.id === s.id) === i,
      );
      unique.sort((a, b) => b.extraMonthly - a.extraMonthly);
      out.push({
        tenantId: t.tenantId,
        name: t.name,
        slug: t.slug,
        status: t.status,
        planSlug: t.planSlug,
        planName: t.planName,
        salesRepId: t.salesRepId,
        salesRepName: t.salesRepName,
        tags: t.tags,
        monthlyPaid: t.monthlyPaid,
        reasons,
        suggestions: unique,
        estimatedExtraMonthly: unique[0]?.extraMonthly ?? 0,
        lastOfferAt: lastOffer.get(t.tenantId)?.toISOString() ?? null,
      });
    }
    out.sort(
      (a, b) => b.estimatedExtraMonthly - a.estimatedExtraMonthly || a.name.localeCompare(b.name),
    );
    return {
      candidates: out,
      totalEstimatedMonthly: round2(out.reduce((a, c) => a + c.estimatedExtraMonthly, 0)),
    };
  }

  /**
   * Matriz función × plan (cuántos la usan en cada plan), bajas de quien la usa
   * frente a quien no (clientes que pagaron en los últimos 12 meses; solo las
   * funciones con registro fechado) y funciones que casi nadie usa.
   */
  async insights(now = new Date()): Promise<AdminAdoptionInsightsDto> {
    const windowStart = new Date(now.getTime() - 365 * DAY);
    const [adoption, plans, payers, intensity] = await Promise.all([
      this.tenants.getAdoption(),
      this.admin.subscriptionPlan.findMany({
        where: { isActive: true },
        select: { slug: true, name: true, priceMonthly: true },
        orderBy: { priceMonthly: 'asc' },
      }),
      loadPayerLifecycles(this.admin, now),
      loadFeatureIntensity(this.admin, null, now, windowStart),
    ]);

    const matrix: AdminFeatureMatrixRowDto[] = TenantFeatures.map((ft) => {
      const byPlan: AdminFeatureMatrixRowDto['byPlan'] = {};
      for (const p of plans) byPlan[p.slug] = { using: 0, withAccess: 0 };
      let using = 0;
      let withAccess = 0;
      for (const t of adoption.tenants) {
        const f = t.features.find((x) => x.feature === ft);
        if (!f) continue;
        const slug = t.planSlug ?? '';
        const cell = (byPlan[slug] ??= { using: 0, withAccess: 0 });
        if (f.used) {
          cell.using += 1;
          using += 1;
        }
        if (f.inPlan || f.viaOverride) {
          cell.withAccess += 1;
          withAccess += 1;
        }
      }
      return { feature: ft, label: FEATURE_LABELS[ft], byPlan, using, withAccess };
    });

    // Clientes que pagaban en algún momento de los últimos 12 meses.
    const population = payers.filter(
      (p) => p.firstPaidAt < now && (!p.churnedAt || p.churnedAt >= windowStart),
    );
    const churned = new Set(
      population.filter((p) => p.churnedAt && p.churnedAt >= windowStart).map((p) => p.tenantId),
    );
    const pct = (num: number, den: number) => (den > 0 ? round2((num / den) * 100) : null);
    const retention: AdminFeatureRetentionDto[] = TenantFeatures.map((ft) => {
      if (!INTENSITY_UNITS[ft]) {
        return {
          feature: ft,
          label: FEATURE_LABELS[ft],
          usedCount: 0,
          notUsedCount: 0,
          usedChurnPct: null,
          notUsedChurnPct: null,
          enoughData: false,
        };
      }
      let used = 0;
      let usedChurned = 0;
      let notUsed = 0;
      let notUsedChurned = 0;
      for (const p of population) {
        const uses = (intensity.get(p.tenantId)?.[ft]?.all ?? 0) > 0;
        const gone = churned.has(p.tenantId);
        if (uses) {
          used += 1;
          if (gone) usedChurned += 1;
        } else {
          notUsed += 1;
          if (gone) notUsedChurned += 1;
        }
      }
      return {
        feature: ft,
        label: FEATURE_LABELS[ft],
        usedCount: used,
        notUsedCount: notUsed,
        usedChurnPct: pct(usedChurned, used),
        notUsedChurnPct: pct(notUsedChurned, notUsed),
        enoughData:
          used >= RETENTION_MIN_GROUP &&
          notUsed >= RETENTION_MIN_GROUP &&
          usedChurned + notUsedChurned >= RETENTION_MIN_CHURNED,
      };
    });

    const rarelyUsed = matrix
      .filter((r) => r.withAccess > 0 && (r.using <= 1 || r.using / r.withAccess < 0.1))
      .map((r) => ({
        feature: r.feature,
        label: r.label,
        using: r.using,
        withAccess: r.withAccess,
      }));

    return {
      plans: plans.map((p) => ({ slug: p.slug, name: p.name })),
      matrix,
      retention,
      rarelyUsed,
      churnedLast12m: churned.size,
    };
  }

  /** Crea el mismo seguimiento en varios tenants (los borrados se saltan). */
  async bulkFollowups(
    input: AdminBulkFollowupsInput,
    meta: { superAdminId: string; ipAddress: string | null; userAgent: string | null },
  ): Promise<AdminBulkFollowupsResultDto> {
    const ids = [...new Set(input.tenantIds)];
    const existing = await this.admin.tenant.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true },
    });
    // Sin indicar quién, lo lleva quien lo crea (si no es comercial).
    let assignedToId = input.assignedToId ?? null;
    if (input.assignedToId === undefined) {
      const me = await this.admin.superAdmin.findUnique({
        where: { id: meta.superAdminId },
        select: { isActive: true, role: true },
      });
      assignedToId = me?.isActive && me.role !== 'sales' ? meta.superAdminId : null;
    }
    if (existing.length > 0) {
      await this.admin.tenantFollowup.createMany({
        data: existing.map((t) => ({
          tenantId: t.id,
          superAdminId: meta.superAdminId,
          title: input.title,
          note: input.note ?? null,
          dueDate: new Date(`${input.dueDate}T00:00:00.000Z`),
          assignedToId,
        })),
      });
    }
    await this.audit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.followups_bulk_created',
      targetType: 'tenant',
      targetId: null,
      targetTenantId: null,
      changes: { tenants: existing.length, title: input.title, dueDate: input.dueDate },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return { created: existing.length, skipped: ids.length - existing.length };
  }
}
