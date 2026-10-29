import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_AI_MONTHLY_QUERY_LIMIT,
  FEATURE_LABELS,
  effectiveFeaturesFromList,
  resolvePlanFeatures,
  type TenantFeature,
} from '@storageos/shared';

import { currentMonth } from '../../common/format';
import { liveOverrideWhere } from '../../common/tenant-features';
import { platformPricing } from '../billing-saas/platform-pricing';
import { SaasAddonsService } from '../billing-saas/saas-addons.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SuperAdminAuditService } from './super-admin-audit.service';
import { TenantLifecycleEmailsService } from './tenant-lifecycle-emails.service';

import type {
  AdminAddonOpportunityDto,
  AdminOpportunityCandidateDto,
  AdminProposeAddonResultDto,
  ProposeAddonInput,
} from '@storageos/shared';

const DAY = 86_400_000;
const OFFER_ACTION = 'admin.saas_addon.proposed';

/** Datos de uso de un tenant para decidir a qué extras es candidato. */
interface TenantSignals {
  facilities: number;
  units: number;
  customers: number;
  activeContracts: number;
  oldContracts: number;
  invoices30d: number;
  overdueInvoices: number;
  hasCustomDomain: boolean;
  features: Set<TenantFeature>;
  maxUnits: number | null;
  maxFacilities: number | null;
}

type Rule = (s: TenantSignals) => string | null;

/**
 * Motivos de uso por función (además del interés). Umbrales prudentes: que
 * la lista sea corta y cada candidato tenga sentido.
 */
const RULES: Partial<Record<TenantFeature, Rule>> = {
  sepa: (s) =>
    s.customers >= 30 ? `${s.customers} inquilinos: domiciliar ahorra cobros a mano` : null,
  bank_reconciliation: (s) =>
    s.invoices30d >= 40 ? `${s.invoices30d} facturas el último mes` : null,
  ai_assistant: (s) => (s.activeContracts >= 50 ? `${s.activeContracts} contratos activos` : null),
  automations: (s) => (s.customers >= 40 ? `${s.customers} inquilinos` : null),
  collections: (s) => (s.overdueInvoices >= 5 ? `${s.overdueInvoices} facturas vencidas` : null),
  rent_increases: (s) =>
    s.oldContracts >= 20 ? `${s.oldContracts} contratos de más de un año sin revisar precio` : null,
  insurance: (s) => (s.activeContracts >= 20 ? `${s.activeContracts} contratos activos` : null),
  access_control: (s) => (s.units >= 30 ? `${s.units} trasteros` : null),
  cameras: (s) => (s.features.has('access_control') ? 'Ya usa control de accesos' : null),
  custom_domain: (s) =>
    s.features.has('web_premium') && !s.hasCustomDomain
      ? 'Tiene Web Premium sin dominio propio'
      : null,
  web_premium: (s) => (s.facilities >= 2 ? `${s.facilities} locales` : null),
  whatsapp_business: (s) => (s.features.has('web_premium') ? 'Tiene Web Premium' : null),
  local_seo: (s) => (s.features.has('web_premium') ? 'Tiene Web Premium' : null),
};

/**
 * Oportunidades de venta de extras: por cada extra del catálogo, los tenants
 * que no lo tienen y tienen motivos para quererlo (han entrado en la función
 * sin tenerla, o su uso lo pide), y la propuesta por correo en un clic.
 */
@Injectable()
export class AdminOpportunitiesService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly addons: SaasAddonsService,
    private readonly lifecycle: TenantLifecycleEmailsService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly followups: AdminTenantFollowupsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  async opportunities(now = new Date()): Promise<AdminAddonOpportunityDto[]> {
    const since30 = new Date(now.getTime() - 30 * DAY);
    const yearAgo = new Date(now.getTime() - 365 * DAY);
    const [catalog, tenants, overrides, owned, interest, offers] = await Promise.all([
      this.admin.subscriptionAddon.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: { deletedAt: null, billingExempt: false, status: { in: ['active', 'trial'] } },
        select: {
          id: true,
          name: true,
          status: true,
          customDomain: true,
          customDomainVerifiedAt: true,
          subscription: {
            select: {
              plan: {
                select: {
                  name: true,
                  slug: true,
                  tenantFeatures: true,
                  maxUnits: true,
                  maxFacilities: true,
                },
              },
            },
          },
        },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: liveOverrideWhere(now),
        select: { tenantId: true, feature: true, enabled: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { suspendedAt: null },
        select: { tenantId: true, addonId: true },
      }),
      this.admin.featureInterestEvent.groupBy({
        by: ['tenantId', 'feature'],
        where: { createdAt: { gte: since30 } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.admin.superAdminAuditLog.findMany({
        where: { action: OFFER_ACTION, occurredAt: { gte: new Date(now.getTime() - 90 * DAY) } },
        select: { targetTenantId: true, changes: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
      }),
    ]);
    const ids = tenants.map((t) => t.id);
    if (ids.length === 0) return [];
    const [facilities, units, customers, contracts, oldContracts, invoices, overdue] =
      await Promise.all([
        this.admin.facility.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        this.admin.unit.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids } },
          _count: { _all: true },
        }),
        this.admin.customer.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        this.admin.contract.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, deletedAt: null, status: { in: ['active', 'ending'] } },
          _count: { _all: true },
        }),
        this.admin.contract.groupBy({
          by: ['tenantId'],
          where: {
            tenantId: { in: ids },
            deletedAt: null,
            status: { in: ['active', 'ending'] },
            signedAt: { lte: yearAgo },
          },
          _count: { _all: true },
        }),
        this.admin.invoice.groupBy({
          by: ['tenantId'],
          where: {
            tenantId: { in: ids },
            deletedAt: null,
            kind: 'invoice',
            status: { in: ['issued', 'paid', 'overdue'] },
            issueDate: { gte: since30 },
          },
          _count: { _all: true },
        }),
        this.admin.invoice.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: ids }, deletedAt: null, kind: 'invoice', status: 'overdue' },
          _count: { _all: true },
        }),
      ]);
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.tenantId, r._count._all]));
    const facBy = count(facilities);
    const unitsBy = count(units);
    const custBy = count(customers);
    const contBy = count(contracts);
    const oldBy = count(oldContracts);
    const invBy = count(invoices);
    const overBy = count(overdue);
    const ownedSet = new Set(owned.map((o) => `${o.tenantId}:${o.addonId}`));
    const interestBy = new Map(
      interest.map((i) => [
        `${i.tenantId}:${i.feature}`,
        { n: i._count._all, last: i._max.createdAt },
      ]),
    );
    const aiOver = await this.aiLimitReasons(tenants, now);
    const offerBy = new Map<string, Date>();
    for (const o of offers) {
      const addonId = (o.changes as { addonId?: string } | null)?.addonId;
      const key = `${o.targetTenantId}:${addonId}`;
      if (addonId && !offerBy.has(key)) offerBy.set(key, o.occurredAt);
    }
    const overridesBy = new Map<string, { feature: TenantFeature; enabled: boolean }[]>();
    for (const o of overrides) {
      const list = overridesBy.get(o.tenantId) ?? [];
      list.push({ feature: o.feature as TenantFeature, enabled: o.enabled });
      overridesBy.set(o.tenantId, list);
    }

    const signals = new Map<string, TenantSignals>();
    for (const t of tenants) {
      const plan = t.subscription?.plan;
      const base = plan ? resolvePlanFeatures(plan) : [];
      signals.set(t.id, {
        facilities: facBy.get(t.id) ?? 0,
        units: unitsBy.get(t.id) ?? 0,
        customers: custBy.get(t.id) ?? 0,
        activeContracts: contBy.get(t.id) ?? 0,
        oldContracts: oldBy.get(t.id) ?? 0,
        invoices30d: invBy.get(t.id) ?? 0,
        overdueInvoices: overBy.get(t.id) ?? 0,
        hasCustomDomain: !!t.customDomainVerifiedAt,
        features: new Set(effectiveFeaturesFromList(base, overridesBy.get(t.id) ?? [])),
        maxUnits: plan?.maxUnits ?? null,
        maxFacilities: plan?.maxFacilities ?? null,
      });
    }

    const result: AdminAddonOpportunityDto[] = [];
    for (const addon of catalog) {
      const feature = addon.feature as TenantFeature | null;
      const candidates: AdminOpportunityCandidateDto[] = [];
      for (const t of tenants) {
        if (ownedSet.has(`${t.id}:${addon.id}`)) continue;
        const s = signals.get(t.id)!;
        if (feature && s.features.has(feature)) continue;
        // Las consultas extra solo sirven a quien tiene el asistente.
        if (addon.grantsAiQueries && !s.features.has('ai_assistant')) continue;
        const reasons: string[] = [];
        const ai = addon.grantsAiQueries ? aiOver.get(t.id) : undefined;
        if (ai) reasons.push(ai);
        const int = feature ? interestBy.get(`${t.id}:${feature}`) : undefined;
        if (int) {
          reasons.push(
            `Ha entrado ${int.n} ${int.n === 1 ? 'vez' : 'veces'} en ${FEATURE_LABELS[feature!]} sin tenerla`,
          );
        }
        const rule = feature ? RULES[feature] : undefined;
        const why = rule?.(s);
        if (why) reasons.push(why);
        // Extras de capacidad: cerca del límite del plan.
        if (addon.grantsUnits && s.maxUnits && s.units >= s.maxUnits * 0.9) {
          reasons.push(`Usa ${s.units} de ${s.maxUnits} trasteros de su plan`);
        }
        if (addon.grantsFacilities && s.maxFacilities && s.facilities >= s.maxFacilities) {
          reasons.push(`Tiene ${s.facilities} de ${s.maxFacilities} locales de su plan`);
        }
        if (reasons.length === 0) continue;
        candidates.push({
          tenantId: t.id,
          tenantName: t.name,
          tenantStatus: t.status,
          planName: t.subscription?.plan.name ?? null,
          reasons,
          interestCount: int?.n ?? 0,
          lastInterestAt: int?.last?.toISOString() ?? null,
          lastOfferAt: offerBy.get(`${t.id}:${addon.id}`)?.toISOString() ?? null,
        });
      }
      // Primero quien ha mostrado interés, luego quien tiene más motivos.
      candidates.sort(
        (a, b) => b.interestCount - a.interestCount || b.reasons.length - a.reasons.length,
      );
      result.push({
        addonId: addon.id,
        addonName: addon.name,
        feature: addon.feature,
        priceMonthly: Number(addon.priceMonthly),
        candidates,
      });
    }
    return result.sort((a, b) => b.candidates.length - a.candidates.length);
  }

  /**
   * Tenants que han llegado al límite de consultas del asistente dos meses
   * seguidos (el pasado y el anterior, o el pasado y el actual), con su límite
   * de ahora: el general más sus extras, o el propio.
   */
  private async aiLimitReasons(tenants: { id: string }[], now: Date): Promise<Map<string, string>> {
    const ids = tenants.map((t) => t.id);
    if (ids.length === 0) return new Map();
    const current = currentMonth(now);
    const [y, m] = current.key.split('-').map(Number) as [number, number];
    const keys = [-2, -1, 0].map((d) => {
      const date = new Date(Date.UTC(y, m - 1 + d, 1));
      return date.toISOString().slice(0, 7);
    });
    const from = new Date(Date.UTC(y, m - 3, 1) - 2 * 3_600_000);
    const [rows, settings, tenantRows, extras] = await Promise.all([
      this.admin.$queryRaw<{ tenant_id: string; month: string; n: number }[]>`
        SELECT tenant_id, to_char(created_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month,
               COUNT(*)::int AS n
        FROM ai_usage_events
        WHERE counts_as_query AND NOT own_key AND created_at >= ${from}
          AND tenant_id = ANY(${ids}::uuid[])
        GROUP BY 1, 2`,
      this.admin.platformAiSettings.findFirst({ select: { monthlyQueryLimit: true } }),
      this.admin.tenant.findMany({
        where: { id: { in: ids } },
        select: { id: true, aiMonthlyLimit: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId: { in: ids }, suspendedAt: null, addon: { grantsAiQueries: { gt: 0 } } },
        select: { tenantId: true, quantity: true, addon: { select: { grantsAiQueries: true } } },
      }),
    ]);
    const general = settings?.monthlyQueryLimit ?? DEFAULT_AI_MONTHLY_QUERY_LIMIT;
    const extraBy = new Map<string, number>();
    for (const e of extras) {
      extraBy.set(
        e.tenantId,
        (extraBy.get(e.tenantId) ?? 0) + (e.addon.grantsAiQueries ?? 0) * e.quantity,
      );
    }
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(`${r.tenant_id}:${r.month}`, r.n);
    const result = new Map<string, string>();
    for (const t of tenantRows) {
      const limit = t.aiMonthlyLimit ?? general + (extraBy.get(t.id) ?? 0);
      if (limit <= 0) continue;
      const [older, last, now0] = keys.map((k) => counts.get(`${t.id}:${k}`) ?? 0) as [
        number,
        number,
        number,
      ];
      if (last >= limit && (older >= limit || now0 >= limit)) {
        result.set(
          t.id,
          `Ha llegado al límite del asistente IA (${limit} consultas) dos meses seguidos`,
        );
      }
    }
    return result;
  }

  /**
   * Propone un extra al tenant por correo (precio, qué le aporta, enlace para
   * contratarlo), con prueba gratis opcional, y deja la conversación y un
   * seguimiento para llamarle.
   */
  async propose(
    tenantId: string,
    input: ProposeAddonInput,
    meta: { superAdminId: string; ipAddress?: string | null; userAgent?: string | null },
  ): Promise<AdminProposeAddonResultDto> {
    const [tenant, addon, pricing] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, deletedAt: true },
      }),
      this.admin.subscriptionAddon.findUnique({ where: { id: input.addonId } }),
      platformPricing(this.admin),
    ]);
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    if (!addon || !addon.isActive) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Extra no encontrado' });
    }
    const owned = await this.admin.tenantSubscriptionAddon.count({
      where: { tenantId, addonId: addon.id, suspendedAt: null },
    });
    if (owned > 0) {
      throw new BadRequestException({
        code: 'addon_already_assigned',
        message: 'El tenant ya tiene este extra.',
      });
    }

    let trialExpiresAt: string | null = null;
    if (input.trialDays) {
      trialExpiresAt = (await this.addons.startTrial(tenantId, addon.id, input.trialDays))
        .expiresAt;
    }

    const recipients = await this.lifecycle.sendAddonOffer(tenantId, {
      tenantName: tenant.name,
      addonName: addon.name,
      description: addon.description,
      priceMonthly: Number(addon.priceMonthly),
      pricesIncludeVat: pricing.includeVat,
      message: input.message ?? null,
      trialUntil: trialExpiresAt ? new Date(trialExpiresAt) : null,
    });

    await this.interactions.create({
      tenantId,
      superAdminId: meta.superAdminId,
      input: {
        type: 'email',
        content: `Propuesta del extra «${addon.name}»${
          trialExpiresAt ? ` con prueba gratis de ${input.trialDays} días` : ''
        }.${input.message ? `\n\n${input.message}` : ''}`,
      },
    });
    let followupId: string | null = null;
    if (input.followupDays > 0) {
      const due = new Date(Date.now() + input.followupDays * DAY);
      const f = await this.followups.create({
        tenantId,
        superAdminId: meta.superAdminId,
        input: {
          title: `Llamar por la propuesta de ${addon.name}`,
          dueDate: due.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }),
        },
      });
      followupId = f.id;
    }
    await this.audit.record({
      superAdminId: meta.superAdminId,
      action: OFFER_ACTION,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { addonId: addon.id, trialDays: input.trialDays ?? null },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { recipients, trialExpiresAt, followupId };
  }
}
