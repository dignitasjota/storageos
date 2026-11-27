import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { NEAR_LIMIT_RATIO } from './adoption-rules';
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
/** Clics al mes de Google a partir de los que se propone SEO Avanzado (configurable). */
export function seoUpsellMinClicks(): number {
  const n = Number(process.env.SEO_ADVANCED_UPSELL_MIN_CLICKS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

/** El mismo extra no se vuelve a proponer al mismo tenant antes de estos días. */
export const ADDON_OFFER_COOLDOWN_DAYS = 14;

/** Datos de uso de un tenant para decidir a qué extras es candidato. */
interface TenantSignals {
  facilities: number;
  units: number;
  /** Inquilinos con algún contrato vivo (no fichas sin contrato). */
  customers: number;
  /** Usuarios activos + invitaciones pendientes (como el límite). */
  users: number;
  /** Usa el control de accesos de verdad (algún dispositivo o credencial). */
  usesAccess: boolean;
  activeContracts: number;
  oldContracts: number;
  invoices30d: number;
  overdueInvoices: number;
  hasCustomDomain: boolean;
  /** Clics de Google a su web los últimos 30 días (Search Console de SEO local). */
  organicClicks30d: number;
  /** Clics al mes a partir de los que se propone SEO Avanzado. */
  seoUpsellMinClicks: number;
  features: Set<TenantFeature>;
  /** Máximos del plan con la capacidad que ya aportan sus extras. */
  maxUnits: number | null;
  maxFacilities: number | null;
  maxUsers: number | null;
}

/** Usa casi todo (o todo) lo que le permite su plan. */
const nearLimit = (use: number, max: number | null): max is number =>
  max !== null && max > 0 && use >= max * NEAR_LIMIT_RATIO;

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
  cameras: (s) =>
    s.features.has('access_control') && s.usesAccess ? 'Ya usa control de accesos' : null,
  custom_domain: (s) =>
    s.features.has('web_premium') && !s.hasCustomDomain
      ? 'Tiene Web Premium sin dominio propio'
      : null,
  web_premium: (s) => (s.facilities >= 2 ? `${s.facilities} locales` : null),
  whatsapp_business: (s) => (s.features.has('web_premium') ? 'Tiene Web Premium' : null),
  local_seo: (s) => (s.features.has('web_premium') ? 'Tiene Web Premium' : null),
  // Ya trabaja el SEO (SEO local), tiene su dominio y Google le trae visitas de verdad.
  seo_advanced: (s) =>
    s.features.has('local_seo') && s.hasCustomDomain && s.organicClicks30d > s.seoUpsellMinClicks
      ? `Tiene SEO local y dominio propio, y Google le trae ${s.organicClicks30d} clics al mes`
      : null,
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

  /** `onlyTenantIds` limita el cálculo a esos tenants (p. ej. la cartera de un comercial). */
  async opportunities(
    now = new Date(),
    onlyTenantIds?: string[],
  ): Promise<AdminAddonOpportunityDto[]> {
    if (onlyTenantIds && onlyTenantIds.length === 0) return [];
    const scope = onlyTenantIds ? { tenantId: { in: onlyTenantIds } } : {};
    const since30 = new Date(now.getTime() - 30 * DAY);
    const yearAgo = new Date(now.getTime() - 365 * DAY);
    const [catalog, tenants, overrides, owned, interest, offers] = await Promise.all([
      this.admin.subscriptionAddon.findMany({
        where: { isActive: true, isSystem: false },
        orderBy: { name: 'asc' },
      }),
      this.admin.tenant.findMany({
        where: {
          deletedAt: null,
          billingExempt: false,
          status: { in: ['active', 'trial'] },
          ...(onlyTenantIds ? { id: { in: onlyTenantIds } } : {}),
        },
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
                  maxUsers: true,
                },
              },
            },
          },
        },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { ...liveOverrideWhere(now), ...scope },
        select: { tenantId: true, feature: true, enabled: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { suspendedAt: null, ...scope },
        select: {
          tenantId: true,
          addonId: true,
          quantity: true,
          addon: { select: { grantsUnits: true, grantsFacilities: true, grantsUsers: true } },
        },
      }),
      this.admin.featureInterestEvent.groupBy({
        by: ['tenantId', 'feature'],
        where: { createdAt: { gte: since30 }, ...scope },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.admin.superAdminAuditLog.findMany({
        where: {
          action: OFFER_ACTION,
          occurredAt: { gte: new Date(now.getTime() - 90 * DAY) },
          ...(onlyTenantIds ? { targetTenantId: { in: onlyTenantIds } } : {}),
        },
        select: { targetTenantId: true, changes: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
      }),
    ]);
    const ids = tenants.map((t) => t.id);
    if (ids.length === 0) return [];
    const [
      facilities,
      units,
      customers,
      contracts,
      oldContracts,
      invoices,
      overdue,
      users,
      invites,
      devices,
      credentials,
      clicks,
    ] = await Promise.all([
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      // Sin los trasteros de locales borrados.
      this.admin.unit.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, facility: { deletedAt: null } },
        _count: { _all: true },
      }),
      // Inquilinos de verdad: con algún contrato vivo.
      this.admin.customer.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: ids },
          deletedAt: null,
          contracts: { some: { deletedAt: null, status: { in: ['active', 'ending'] } } },
        },
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
      // Facturas (sin justificantes de fianza) vencidas.
      this.admin.invoice.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, deletedAt: null, kind: 'invoice', status: 'overdue' },
        _count: { _all: true },
      }),
      this.admin.user.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, isActive: true },
        _count: { _all: true },
      }),
      this.admin.invitation.groupBy({
        by: ['tenantId'],
        where: {
          tenantId: { in: ids },
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        _count: { _all: true },
      }),
      this.admin.accessDevice.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, isActive: true },
        _count: { _all: true },
      }),
      this.admin.accessCredential.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, revokedAt: null },
        _count: { _all: true },
      }),
      // Clics de Google de los últimos 30 días (Search Console de SEO local).
      this.admin.searchConsoleDay.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, date: { gte: since30 } },
        _sum: { clicks: true },
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
    const usersBy = count(users);
    const invitesBy = count(invites);
    const devicesBy = count(devices);
    const credentialsBy = count(credentials);
    const clicksBy = new Map(clicks.map((c) => [c.tenantId, c._sum.clicks ?? 0]));
    const minClicks = seoUpsellMinClicks();
    const ownedSet = new Set(owned.map((o) => `${o.tenantId}:${o.addonId}`));
    // Capacidad que ya aportan los extras contratados (como el límite efectivo).
    const grantsBy = new Map<string, { units: number; facilities: number; users: number }>();
    for (const o of owned) {
      const g = grantsBy.get(o.tenantId) ?? { units: 0, facilities: 0, users: 0 };
      g.units += (o.addon.grantsUnits ?? 0) * o.quantity;
      g.facilities += (o.addon.grantsFacilities ?? 0) * o.quantity;
      g.users += (o.addon.grantsUsers ?? 0) * o.quantity;
      grantsBy.set(o.tenantId, g);
    }
    const plusGrants = (max: number | null | undefined, extra: number): number | null =>
      max === null || max === undefined ? null : max + extra;
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
      const grants = grantsBy.get(t.id) ?? { units: 0, facilities: 0, users: 0 };
      signals.set(t.id, {
        facilities: facBy.get(t.id) ?? 0,
        units: unitsBy.get(t.id) ?? 0,
        customers: custBy.get(t.id) ?? 0,
        users: (usersBy.get(t.id) ?? 0) + (invitesBy.get(t.id) ?? 0),
        usesAccess: (devicesBy.get(t.id) ?? 0) + (credentialsBy.get(t.id) ?? 0) > 0,
        activeContracts: contBy.get(t.id) ?? 0,
        oldContracts: oldBy.get(t.id) ?? 0,
        invoices30d: invBy.get(t.id) ?? 0,
        overdueInvoices: overBy.get(t.id) ?? 0,
        hasCustomDomain: !!t.customDomainVerifiedAt,
        organicClicks30d: clicksBy.get(t.id) ?? 0,
        seoUpsellMinClicks: minClicks,
        features: new Set(effectiveFeaturesFromList(base, overridesBy.get(t.id) ?? [])),
        maxUnits: plusGrants(plan?.maxUnits, grants.units),
        maxFacilities: plusGrants(plan?.maxFacilities, grants.facilities),
        maxUsers: plusGrants(plan?.maxUsers, grants.users),
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
        // Extras de capacidad: cerca del límite (el mismo umbral que Adopción),
        // contando lo que ya le dan sus extras.
        if (addon.grantsUnits && nearLimit(s.units, s.maxUnits)) {
          reasons.push(`Usa ${s.units} de ${s.maxUnits} trasteros de su plan`);
        }
        if (addon.grantsFacilities && nearLimit(s.facilities, s.maxFacilities)) {
          reasons.push(`Tiene ${s.facilities} de ${s.maxFacilities} locales de su plan`);
        }
        if (addon.grantsUsers && nearLimit(s.users, s.maxUsers)) {
          reasons.push(`Tiene ${s.users} de ${s.maxUsers} usuarios de su plan`);
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
      this.admin.platformAiSettings.findFirst({
        select: { monthlyQueryLimit: true, planLimits: true },
      }),
      this.admin.tenant.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          aiMonthlyLimit: true,
          subscription: { select: { plan: { select: { slug: true } } } },
        },
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
      const planLimits = (settings?.planLimits ?? {}) as Record<string, unknown>;
      const slug = t.subscription?.plan.slug;
      const base =
        slug && typeof planLimits[slug] === 'number' ? (planLimits[slug] as number) : general;
      const limit = (t.aiMonthlyLimit ?? base) + (extraBy.get(t.id) ?? 0);
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
    meta: {
      superAdminId: string;
      ipAddress?: string | null;
      userAgent?: string | null;
      /** Propuesta suelta o de un envío a varios. */
      source?: 'single' | 'bulk';
    },
  ): Promise<AdminProposeAddonResultDto> {
    const [tenant, addon, pricing] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, deletedAt: true, status: true },
      }),
      this.admin.subscriptionAddon.findUnique({ where: { id: input.addonId } }),
      platformPricing(this.admin),
    ]);
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    // A un tenant suspendido o de baja no se le venden extras.
    if (tenant.status !== 'active' && tenant.status !== 'trial') {
      throw new BadRequestException({
        code: 'tenant_not_live',
        message: 'El tenant está suspendido o de baja: no se le proponen extras.',
      });
    }
    if (!addon || !addon.isActive) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'Extra no encontrado' });
    }
    const since = new Date(Date.now() - ADDON_OFFER_COOLDOWN_DAYS * DAY);
    const [owned, recentOffers, triedBefore] = await Promise.all([
      this.admin.tenantSubscriptionAddon.count({
        where: { tenantId, addonId: addon.id, suspendedAt: null },
      }),
      this.admin.superAdminAuditLog.findMany({
        where: { action: OFFER_ACTION, targetTenantId: tenantId, occurredAt: { gte: since } },
        select: { changes: true, occurredAt: true },
        orderBy: { occurredAt: 'desc' },
      }),
      input.trialDays
        ? this.admin.tenantAddonTrial.count({ where: { tenantId, addonId: addon.id } })
        : Promise.resolve(0),
    ]);
    if (owned > 0) {
      throw new BadRequestException({
        code: 'addon_already_assigned',
        message: 'El tenant ya tiene este extra.',
      });
    }
    const lastOffer = recentOffers.find(
      (o) => (o.changes as { addonId?: string } | null)?.addonId === addon.id,
    );
    if (lastOffer) {
      throw new ConflictException({
        code: 'addon_offer_recent',
        message: `Ya se le propuso este extra el ${lastOffer.occurredAt.toLocaleDateString(
          'es-ES',
          {
            day: 'numeric',
            month: 'long',
            timeZone: 'Europe/Madrid',
          },
        )}: espera a que pasen ${ADDON_OFFER_COOLDOWN_DAYS} días para volver a proponérselo.`,
      });
    }
    if (triedBefore > 0) {
      throw new ConflictException({
        code: 'addon_trial_used',
        message: 'Ya tuvo una prueba gratis de este extra: proponlo sin prueba.',
      });
    }
    // Sin nadie a quien escribir, nada: ni prueba, ni conversación, ni seguimiento.
    if ((await this.lifecycle.addonOfferRecipients(tenantId)) === 0) {
      throw new BadRequestException({
        code: 'no_recipients',
        message:
          'No tiene a quién escribir (sin propietarios verificados o se han dado de baja de las ofertas).',
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
    // Registro de la propuesta: su estado y la tasa de aceptación por extra.
    await this.admin.platformAddonOffer.create({
      data: {
        tenantId,
        addonId: addon.id,
        superAdminId: meta.superAdminId,
        trialDays: input.trialDays ?? null,
        trialUntil: trialExpiresAt ? new Date(trialExpiresAt) : null,
        recipients,
        source: meta.source ?? 'single',
      },
    });
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
