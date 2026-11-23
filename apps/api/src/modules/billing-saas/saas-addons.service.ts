import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  addonUnitPrice,
  parseAddonPriceTiers,
  resolvePlanFeatures,
  type TenantFeature,
  EXTRA_UNITS_ADDON_SLUG,
  extraUnitsFor,
  SELF_ADDON_TRIAL_DAYS,
  TenantFeatures,
} from '@storageos/shared';
import StripeSDK from 'stripe';

import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { StripeGateway } from '../payments/stripe.gateway';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

import { billableUnits } from './billable-units';
import { CatalogPriceHistoryService } from './catalog-price-history.service';
import { amountToCharge, platformPricing } from './platform-pricing';

import type {
  AddonBillingMode,
  AdminAddonAnalyticsDto,
  AssignAddonInput,
  SaasAddonDto,
  TenantAddonDto,
  TenantBillingStatusDto,
  TenantBillingSummaryDto,
  TenantLimitsDto,
  TenantSelfAddonsDto,
  UpdateTenantAddonInput,
  UpsertSaasAddonInput,
} from '@storageos/shared';

type StripeClient = InstanceType<typeof StripeSDK>;

const num = (d: Prisma.Decimal | number): number => Number(d);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Motor de add-ons facturables del SaaS. `subscription_addons` es el catálogo
 * GLOBAL (como subscription_plans); `tenant_subscription_addons` son los
 * contratados por cada tenant. v1 desacoplado de Stripe: el importe efectivo
 * (plan + add-ons) alimenta las métricas y el importe sugerido del pago manual.
 * Asignar un add-on con `feature` activa el override de esa feature del tenant.
 */
/** Tramos de precio para guardar (null = precio único). */
function tiersValue(
  tiers: { minQuantity: number; unitPrice: number }[] | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return tiers && tiers.length > 0
    ? (parseAddonPriceTiers(tiers) as unknown as Prisma.InputJsonValue)
    : Prisma.DbNull;
}

/** Si el extra se puede tener en ese plan (vacío = en cualquiera). */
export function addonFitsPlan(addon: { planSlugs: string[] }, planSlug: string | null): boolean {
  return addon.planSlugs.length === 0 || (!!planSlug && addon.planSlugs.includes(planSlug));
}

/** Plan y cantidad permitidos para contratar un extra. */
function assertAddonAllowed(
  addon: { planSlugs: string[]; maxQuantity: number | null },
  planSlug: string | null,
  quantity: number,
): void {
  if (!addonFitsPlan(addon, planSlug)) {
    throw new BadRequestException({
      code: 'addon_not_for_plan',
      message: 'Este extra no está disponible en tu plan.',
    });
  }
  if (addon.maxQuantity != null && quantity > addon.maxQuantity) {
    throw new BadRequestException({
      code: 'addon_max_quantity',
      message: `Como mucho ${addon.maxQuantity} de este extra.`,
      details: { maxQuantity: addon.maxQuantity },
    });
  }
}

@Injectable()
export class SaasAddonsService {
  private readonly logger = new Logger(SaasAddonsService.name);
  private readonly stripe: StripeClient;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly limits: PlanLimitsService,
    private readonly stripeGateway: StripeGateway,
    private readonly priceHistory: CatalogPriceHistoryService,
  ) {
    this.stripe = stripeGateway.getClient();
  }

  /** Corta con 503 si Stripe no está configurado (clave placeholder de dev/test). */
  private assertStripeConfigured(): void {
    if (!this.stripeGateway.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'payments_not_configured',
        message: 'El cobro por Stripe no está configurado todavía.',
      });
    }
  }

  /** Estado de cuenta del tenant: pagos pendientes (plan past_due + add-ons suspendidos). */
  async billingStatus(tenantId: string): Promise<TenantBillingStatusDto> {
    const [subscription, suspended] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: { status: true, stripeSubscriptionId: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId, suspendedAt: { not: null } },
        select: { addon: { select: { name: true, feature: true } } },
      }),
    ]);
    const tenantRow = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { billingExempt: true, status: true },
    });
    const exempt = tenantRow?.billingExempt;
    // Cuenta suspendida (impago o a mano): el panel queda en solo lectura y sus
    // inquilinos no pueden entrar al área de clientes hasta que pague.
    const suspendedAccount = tenantRow?.status === 'suspended';
    // Una cuenta exenta no paga: nunca está «pendiente de pago».
    const pastDue = !exempt && subscription?.status === 'past_due';
    // Plan impagado sin Stripe = pago manual: no hay portal de pago online, el
    // tenant regulariza avisando a soporte («He realizado el pago»).
    const planManual = pastDue && !subscription?.stripeSubscriptionId;
    // Prueba o plan gratuito terminados sin pagar: solo lectura hasta que pague.
    const expired = !exempt && !suspendedAccount && subscription?.status === 'expired';
    const suspendedAddons = suspended.map((s) => ({
      name: s.addon.name,
      feature: s.addon.feature,
    }));
    const suspendedFeatures = suspendedAddons
      .map((a) => a.feature)
      .filter((f): f is string => f !== null);
    // Lo que sus inquilinos deben y no se les está cobrando hasta que pague.
    let heldAmount = 0;
    if (suspendedAccount) {
      const agg = await this.admin.invoice.aggregate({
        where: {
          tenantId,
          kind: 'invoice',
          deletedAt: null,
          status: { in: ['issued', 'overdue'] },
          total: { gt: 0 },
        },
        _sum: { total: true, amountPaid: true, amountRefunded: true },
      });
      const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
      heldAmount =
        Math.max(
          0,
          cents(agg._sum.total) - cents(agg._sum.amountPaid) - cents(agg._sum.amountRefunded),
        ) / 100;
    }
    return {
      pastDue,
      planManual,
      suspendedAddons,
      suspendedFeatures,
      suspended: suspendedAccount,
      heldAmount,
      expired,
      hasIssue: pastDue || suspendedAccount || expired || suspendedAddons.length > 0,
    };
  }

  /** Límites del plan (+ add-ons de capacidad) y uso actual del tenant. */
  async tenantLimits(tenantId: string): Promise<TenantLimitsDto> {
    const [units, facilities, users] = await Promise.all([
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
    ]);
    return this.limits.getUsage(tenantId, { units, facilities, users });
  }

  // ---- catálogo ----

  async listCatalog(): Promise<SaasAddonDto[]> {
    const [rows, counts] = await Promise.all([
      this.admin.subscriptionAddon.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
      this.admin.tenantSubscriptionAddon.groupBy({
        by: ['addonId'],
        where: { tenant: { deletedAt: null } },
        _count: { _all: true },
      }),
    ]);
    const by = new Map(counts.map((c) => [c.addonId, c._count._all]));
    return rows.map((r) => ({ ...this.toCatalogDto(r), tenantCount: by.get(r.id) ?? 0 }));
  }

  /**
   * Analítica global del catálogo (cross-tenant): por cada add-on, cuántos
   * tenants lo tienen activo/suspendido y su MRR. Para decisiones de producto
   * (adopción, candidatos a discontinuar).
   */
  async catalogAnalytics(): Promise<AdminAddonAnalyticsDto[]> {
    const [catalog, assignments] = await Promise.all([
      this.admin.subscriptionAddon.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
      // Solo tenants vivos y no exentos (una cuenta borrada o exenta no cuenta).
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenant: { deletedAt: null, billingExempt: false } },
        select: {
          addonId: true,
          priceMonthly: true,
          quantity: true,
          suspendedAt: true,
          tenant: { select: { status: true, subscription: { select: { status: true } } } },
        },
      }),
    ]);
    const stats = new Map<string, { active: number; suspended: number; revenue: number }>();
    for (const a of assignments) {
      const e = stats.get(a.addonId) ?? { active: 0, suspended: 0, revenue: 0 };
      if (a.suspendedAt) {
        e.suspended += 1;
      } else {
        e.active += 1;
        // El MRR solo de quien paga: misma definición que Métricas y Finanzas.
        const paying =
          (a.tenant.status === 'active' || a.tenant.status === 'trial') &&
          a.tenant.subscription?.status === 'active';
        if (paying) e.revenue += num(a.priceMonthly) * a.quantity;
      }
      stats.set(a.addonId, e);
    }
    return catalog.map((c) => {
      const e = stats.get(c.id) ?? { active: 0, suspended: 0, revenue: 0 };
      return {
        addonId: c.id,
        name: c.name,
        slug: c.slug,
        feature: c.feature,
        priceMonthly: num(c.priceMonthly),
        isActive: c.isActive,
        tenantsActive: e.active,
        tenantsSuspended: e.suspended,
        monthlyRevenue: round2(e.revenue),
      };
    });
  }

  async createAddon(
    input: UpsertSaasAddonInput,
    superAdminId: string | null = null,
  ): Promise<SaasAddonDto> {
    this.validateFeature(input.feature);
    const exists = await this.admin.subscriptionAddon.findUnique({ where: { slug: input.slug } });
    if (exists) {
      throw new BadRequestException({ code: 'slug_taken', message: 'Ese slug ya existe' });
    }
    const created = await this.admin.subscriptionAddon.create({
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description || null,
        priceMonthly: input.priceMonthly,
        feature: input.feature || null,
        grantsUnits: input.grantsUnits ?? null,
        grantsFacilities: input.grantsFacilities ?? null,
        grantsUsers: input.grantsUsers ?? null,
        grantsAiQueries: input.grantsAiQueries ?? null,
        priceTiers: tiersValue(input.priceTiers),
        planSlugs: input.planSlugs ?? [],
        maxQuantity: input.maxQuantity ?? null,
        isActive: input.isActive,
      },
    });
    await this.priceHistory.record({
      kind: 'addon',
      itemId: created.id,
      itemName: created.name,
      oldMonthly: null,
      newMonthly: num(created.priceMonthly),
      superAdminId,
    });
    return this.toCatalogDto(created);
  }

  async updateAddon(
    id: string,
    input: UpsertSaasAddonInput,
    superAdminId: string | null = null,
  ): Promise<SaasAddonDto> {
    this.validateFeature(input.feature);
    const current = await this.findAddon(id);
    if (current.isSystem) {
      // Los trasteros de más se buscan por su slug y se cobran con la cuota: de
      // este extra solo se cambian el nombre, la descripción y el precio.
      input = {
        ...input,
        slug: current.slug,
        feature: '',
        grantsUnits: null,
        grantsFacilities: null,
        grantsUsers: null,
        grantsAiQueries: null,
        planSlugs: current.planSlugs,
        maxQuantity: null,
        isActive: true,
      };
    }
    // Cambiar la `feature` de un add-on YA asignado dejaría overrides
    // desincronizados (los tenants perderían/ganarían features sin motivo).
    const newFeature = input.feature || null;
    if (newFeature !== current.feature) {
      const assignments = await this.admin.tenantSubscriptionAddon.count({
        where: { addonId: id },
      });
      if (assignments > 0) {
        throw new BadRequestException({
          code: 'addon_feature_locked',
          message:
            'No se puede cambiar la feature de un add-on ya asignado a tenants. Crea uno nuevo.',
        });
      }
    }
    const clash = await this.admin.subscriptionAddon.findFirst({
      where: { slug: input.slug, id: { not: id } },
      select: { id: true },
    });
    if (clash) throw new BadRequestException({ code: 'slug_taken', message: 'Ese slug ya existe' });
    const updated = await this.admin.subscriptionAddon.update({
      where: { id },
      data: {
        slug: input.slug,
        name: input.name,
        description: input.description || null,
        priceMonthly: input.priceMonthly,
        feature: input.feature || null,
        grantsUnits: input.grantsUnits ?? null,
        grantsFacilities: input.grantsFacilities ?? null,
        grantsUsers: input.grantsUsers ?? null,
        grantsAiQueries: input.grantsAiQueries ?? null,
        ...(input.priceTiers !== undefined ? { priceTiers: tiersValue(input.priceTiers) } : {}),
        ...(input.planSlugs !== undefined ? { planSlugs: input.planSlugs } : {}),
        ...(input.maxQuantity !== undefined ? { maxQuantity: input.maxQuantity } : {}),
        isActive: input.isActive,
      },
    });
    await this.priceHistory.record({
      kind: 'addon',
      itemId: id,
      itemName: updated.name,
      oldMonthly: num(current.priceMonthly),
      newMonthly: num(updated.priceMonthly),
      superAdminId,
    });
    // Si cambió el precio y ya está mapeado a Stripe, crea un Price nuevo (Prices
    // inmutables) para futuras activaciones en modo Stripe. Best-effort.
    if (updated.stripePriceId && num(current.priceMonthly) !== input.priceMonthly) {
      await this.syncStripePriceForAddon(id);
    }
    return this.toCatalogDto(updated);
  }

  // ---- por tenant ----

  async billingSummary(tenantId: string): Promise<TenantBillingSummaryDto> {
    const [subscription, addons] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { name: true, slug: true, priceMonthly: true } } },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId },
        include: {
          addon: { select: { name: true, slug: true, feature: true, isSystem: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const planMonthly = subscription ? num(subscription.plan.priceMonthly) : 0;
    const addonDtos = addons.map((a) => this.toTenantAddonDto(a));
    // Los suspendidos se muestran (para reactivarlos) pero NO suman al total.
    const addonsMonthly = round2(
      addonDtos.filter((a) => !a.suspended).reduce((s, a) => s + a.lineTotal, 0),
    );
    const effectiveMonthly = round2(planMonthly + addonsMonthly);
    const pricing = await platformPricing(this.admin);
    return {
      planName: subscription?.plan.name ?? null,
      planSlug: subscription?.plan.slug ?? null,
      planMonthly,
      addons: addonDtos,
      addonsMonthly,
      effectiveMonthly,
      pricesIncludeVat: pricing.includeVat,
      effectiveMonthlyToCharge: amountToCharge(effectiveMonthly, pricing),
    };
  }

  /** MRR mensual de los add-ons de un tenant (para métricas). */
  async addonsMonthly(tenantId: string): Promise<number> {
    const addons = await this.admin.tenantSubscriptionAddon.findMany({
      where: { tenantId, suspendedAt: null },
      select: { priceMonthly: true, quantity: true },
    });
    return round2(addons.reduce((s, a) => s + num(a.priceMonthly) * a.quantity, 0));
  }

  // ---- trasteros de más (plan Basic) ----

  /**
   * Pone al día los trasteros de más de un plan por trastero (Basic): los que
   * pasan de los incluidos, contados ahora. No se cobran nunca aparte: van en
   * el mismo cargo que la cuota, por la vía que sea. Por eso se llama justo
   * antes de cada cobro (remesa SEPA, Redsys, Checkout) y cada día, que es lo
   * que deja en Stripe la cantidad de la próxima factura. Sin prorrateos.
   * Devuelve si ha cambiado algo.
   */
  async syncExtraUnits(tenantId: string): Promise<boolean> {
    const [sub, addon] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          billingMode: true,
          stripeSubscriptionId: true,
          plan: { select: { includedUnits: true } },
          tenant: { select: { billingExempt: true, deletedAt: true } },
        },
      }),
      this.admin.subscriptionAddon.findUnique({ where: { slug: EXTRA_UNITS_ADDON_SLUG } }),
    ]);
    if (!sub || !addon) return false;
    const row = await this.admin.tenantSubscriptionAddon.findUnique({
      where: { tenantId_addonId: { tenantId, addonId: addon.id } },
    });
    const included = sub.plan.includedUnits;
    const extra =
      included == null || sub.tenant.billingExempt || sub.tenant.deletedAt
        ? 0
        : extraUnitsFor(await billableUnits(this.admin, tenantId), included);
    if (extra === 0) {
      if (!row) return false;
      if (row.billingMode === 'stripe' && row.stripeSubscriptionItemId) {
        // Sin abonar lo ya cobrado: la cantidad deja de contar desde la próxima factura.
        await this.deleteStripeItem(row.stripeSubscriptionItemId, false);
      }
      await this.admin.tenantSubscriptionAddon.delete({ where: { id: row.id } });
      return true;
    }
    const current =
      row ??
      (await this.admin.tenantSubscriptionAddon.create({
        data: {
          tenantId,
          addonId: addon.id,
          priceMonthly: addon.priceMonthly,
          quantity: extra,
          // Nunca un cobro aparte (no sale en «Hoy»): va con la cuota.
          nextChargeAt: null,
        },
      }));
    const onStripe = sub.billingMode === 'stripe' && !!sub.stripeSubscriptionId;
    if (onStripe) {
      const linked = current.billingMode === 'stripe' && !!current.stripeSubscriptionItemId;
      if (linked && current.quantity === extra && !row?.suspendedAt) return !row;
      // Si Stripe falla no se marca nada: mañana se vuelve a intentar.
      await this.attachExtraUnitsItem(current.id, sub.stripeSubscriptionId!, addon, extra).catch(
        (err: unknown) =>
          this.logger.warn(`[basic] trasteros de más en Stripe (${tenantId}): ${String(err)}`),
      );
      return true;
    }
    if (
      row &&
      row.quantity === extra &&
      row.billingMode !== 'stripe' &&
      !row.suspendedAt &&
      !row.nextChargeAt
    ) {
      return false;
    }
    await this.admin.tenantSubscriptionAddon.update({
      where: { id: current.id },
      data: {
        quantity: extra,
        billingMode: 'manual',
        stripeSubscriptionItemId: null,
        nextChargeAt: null,
        suspendedAt: null,
      },
    });
    return true;
  }

  /**
   * Enlaza los trasteros de más con su elemento de la suscripción de Stripe: si
   * ya existe (el del Checkout) lo reutiliza; si no, lo crea. Sin prorrateo: la
   * cantidad vale desde la próxima factura. La fila solo cambia si Stripe acepta.
   */
  private async attachExtraUnitsItem(
    tenantAddonId: string,
    stripeSubscriptionId: string,
    addon: Parameters<SaasAddonsService['ensureStripePrice']>[0],
    quantity: number,
  ): Promise<void> {
    const priceId = await this.ensureStripePrice(addon);
    const items = await this.stripe.subscriptionItems.list({
      subscription: stripeSubscriptionId,
      limit: 100,
    });
    const existing = items.data.find((i) => i.price.id === priceId);
    const item = existing
      ? await this.stripe.subscriptionItems.update(existing.id, {
          quantity,
          proration_behavior: 'none',
          metadata: { kind: 'addon', tenantAddonId, addonId: addon.id },
        })
      : await this.stripe.subscriptionItems.create({
          subscription: stripeSubscriptionId,
          price: priceId,
          quantity,
          proration_behavior: 'none',
          metadata: { kind: 'addon', tenantAddonId, addonId: addon.id },
        });
    await this.admin.tenantSubscriptionAddon.update({
      where: { id: tenantAddonId },
      data: {
        billingMode: 'stripe',
        stripeSubscriptionItemId: item.id,
        quantity,
        nextChargeAt: null,
        suspendedAt: null,
      },
    });
  }

  /** Línea de los trasteros de más para el Checkout de Stripe (vacía si no hay). */
  async extraUnitsCheckoutLine(
    tenantId: string,
    includedUnits: number | null,
  ): Promise<{ price: string; quantity: number }[]> {
    if (includedUnits == null) return [];
    const extra = extraUnitsFor(await billableUnits(this.admin, tenantId), includedUnits);
    if (extra === 0) return [];
    const addon = await this.admin.subscriptionAddon.findUnique({
      where: { slug: EXTRA_UNITS_ADDON_SLUG },
    });
    if (!addon) return [];
    return [{ price: await this.ensureStripePrice(addon), quantity: extra }];
  }

  /**
   * Tarea diaria: pone al día los trasteros de más de las cuentas por trastero
   * (y quita los que quedaron de cuentas que ya no lo son).
   */
  async syncAllExtraUnits(): Promise<number> {
    const [subs, leftovers] = await Promise.all([
      this.admin.tenantSubscription.findMany({
        where: { plan: { includedUnits: { not: null } }, tenant: { deletedAt: null } },
        select: { tenantId: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { addon: { isSystem: true } },
        select: { tenantId: true },
      }),
    ]);
    const ids = new Set([...subs, ...leftovers].map((s) => s.tenantId));
    let changed = 0;
    for (const tenantId of ids) {
      try {
        if (await this.syncExtraUnits(tenantId)) changed += 1;
      } catch (err) {
        this.logger.warn(`[basic] trasteros de más de ${tenantId}: ${String(err)}`);
      }
    }
    return changed;
  }

  /**
   * Tras un cambio de plan: quita los extras que el plan nuevo ya incluye o que
   * no se pueden tener en él (p. ej. el segundo usuario de Basic) y avisa al
   * cliente; fija ya los trasteros de más si el plan nuevo es por trastero.
   */
  async reconcileAfterPlanChange(tenantId: string): Promise<string[]> {
    const { planFeatures, planSlug } = await this.planContext(tenantId);
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: { tenantId },
      include: { addon: true },
    });
    const removed: string[] = [];
    for (const r of rows) {
      if (r.addon.isSystem) continue;
      const included = !!r.addon.feature && planFeatures.includes(r.addon.feature as TenantFeature);
      if (included || !addonFitsPlan(r.addon, planSlug)) {
        await this.remove(tenantId, r.id);
        removed.push(r.addon.name);
      }
    }
    await this.syncExtraUnits(tenantId);
    if (removed.length > 0) {
      await this.admin.notification
        .create({
          data: {
            tenantId,
            type: 'billing.addons_removed',
            title:
              removed.length === 1
                ? `Ya no pagas aparte «${removed[0]}»`
                : `Ya no pagas aparte ${removed.length} extras`,
            body: `Con tu nuevo plan no hacen falta: ${removed.join(', ')}.`,
            link: '/settings/saas-billing',
          },
        })
        .catch(() => undefined);
    }
    return removed;
  }

  // ---- self-service del tenant ----

  /** Add-ons del tenant + catálogo disponible (activos que aún no tiene). */
  async selfServiceView(tenantId: string): Promise<TenantSelfAddonsDto> {
    const [summary, catalog] = await Promise.all([
      this.billingSummary(tenantId),
      this.admin.subscriptionAddon.findMany({
        where: { isActive: true },
        orderBy: [{ name: 'asc' }],
      }),
    ]);
    const owned = new Set(summary.addons.map((a) => a.addonId));
    const { planFeatures, billingExempt, planSlug } = await this.planContext(tenantId);
    // Las consultas extra del asistente solo tienen sentido con el asistente.
    const hasAi = await tenantHasFeature(this.admin, tenantId, 'ai_assistant');
    const notOwned = catalog.filter(
      (a) =>
        !owned.has(a.id) &&
        !a.isSystem &&
        addonFitsPlan(a, planSlug) &&
        (hasAi || !(a.grantsAiQueries && a.grantsAiQueries > 0)),
    );
    const inPlan = (a: { feature: string | null }) =>
      !!a.feature && planFeatures.includes(a.feature as TenantFeature);
    const available = notOwned.filter((a) => !inPlan(a)).map((a) => this.toCatalogDto(a));
    const includedInPlan = notOwned.filter(inPlan).map((a) => this.toCatalogDto(a));
    // Las `notes` de la asignación son internas del super admin: no exponerlas al
    // tenant en su self-service.
    const tenantSummary = {
      ...summary,
      addons: summary.addons.map((a) => ({ ...a, notes: null })),
    };
    const trialRows = await this.admin.tenantFeatureOverride.findMany({
      where: {
        tenantId,
        source: 'trial',
        trialAddonId: { not: null },
        expiresAt: { gt: new Date() },
      },
      select: { trialAddonId: true, expiresAt: true },
    });
    const trials = trialRows.map((t) => ({
      addonId: t.trialAddonId!,
      expiresAt: t.expiresAt!.toISOString(),
    }));
    return { summary: tenantSummary, available, includedInPlan, billingExempt, trials };
  }

  /** Nombre del extra de una asignación del tenant (para el registro de bajas). */
  async assignmentName(tenantId: string, assignmentId: string): Promise<string | null> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: assignmentId, tenantId },
      select: { addon: { select: { name: true } } },
    });
    return row?.addon.name ?? null;
  }

  /**
   * Prueba gratis de un extra durante `days` días: activa su función con fecha
   * de fin. Al contratarlo pasa a ser el extra de siempre; si no, la tarea de
   * caducidades lo quita y avisa al tenant.
   */
  async startTrial(
    tenantId: string,
    addonId: string,
    days: number,
    opts: { source?: 'admin' | 'self'; userId?: string } = {},
  ): Promise<{ feature: string; expiresAt: string }> {
    const addon = await this.findAddon(addonId);
    if (!addon.isActive || addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_not_available',
        message: 'Este extra está desactivado en el catálogo.',
      });
    }
    if (!addon.feature || !(TenantFeatures as readonly string[]).includes(addon.feature)) {
      throw new BadRequestException({
        code: 'addon_without_feature',
        message: 'Este extra no activa ninguna función: no tiene prueba gratis.',
      });
    }
    const [owned, existing, ctx] = await Promise.all([
      this.admin.tenantSubscriptionAddon.count({
        where: { tenantId, addonId, suspendedAt: null },
      }),
      this.admin.tenantFeatureOverride.findUnique({
        where: { tenantId_feature: { tenantId, feature: addon.feature } },
        select: { source: true, enabled: true },
      }),
      this.planContext(tenantId),
    ]);
    if (owned > 0 || existing?.source === 'addon') {
      throw new BadRequestException({
        code: 'addon_already_assigned',
        message: 'El tenant ya tiene este extra contratado.',
      });
    }
    if (ctx.planFeatures.includes(addon.feature as TenantFeature)) {
      throw new BadRequestException({
        code: 'feature_in_plan',
        message: 'Su plan ya incluye esta función.',
      });
    }
    if (existing?.source === 'manual' && existing.enabled) {
      throw new BadRequestException({
        code: 'feature_already_enabled',
        message: 'Ya la tiene activada como cortesía.',
      });
    }
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await this.admin.tenantFeatureOverride.upsert({
      where: { tenantId_feature: { tenantId, feature: addon.feature } },
      create: {
        tenantId,
        feature: addon.feature,
        enabled: true,
        source: 'trial',
        expiresAt,
        trialAddonId: addon.id,
      },
      update: {
        enabled: true,
        source: 'trial',
        expiresAt,
        trialAddonId: addon.id,
        expiryNotifiedAt: null,
      },
    });
    // Constancia de la prueba (se conserva al caducar): el autoservicio solo
    // permite una por extra y negocio.
    await this.admin.tenantAddonTrial.upsert({
      where: { tenantId_addonId: { tenantId, addonId: addon.id } },
      create: {
        tenantId,
        addonId: addon.id,
        source: opts.source ?? 'admin',
        startedByUserId: opts.userId ?? null,
        expiresAt,
      },
      update: { startedAt: new Date(), expiresAt },
    });
    return { feature: addon.feature, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Prueba gratis que activa el propio negocio (desde una novedad): una sola
   * por extra y negocio (409 `addon_trial_used`), con los días de siempre.
   * Avisa al super admin.
   */
  async selfStartTrial(
    tenantId: string,
    addonId: string,
    userId: string,
  ): Promise<{ feature: string; expiresAt: string }> {
    // Una prueba por función: probar otro extra que da lo mismo tampoco vale.
    const addon = await this.findAddon(addonId);
    const [tried, running] = await Promise.all([
      this.admin.tenantAddonTrial.findMany({ where: { tenantId }, select: { addonId: true } }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId, trialAddonId: { not: null } },
        select: { trialAddonId: true },
      }),
    ]);
    const triedIds = [...tried.map((t) => t.addonId), ...running.map((t) => t.trialAddonId!)];
    const sameFeature =
      triedIds.length > 0 &&
      (triedIds.includes(addonId) ||
        (addon.feature != null &&
          (await this.admin.subscriptionAddon.count({
            where: { id: { in: triedIds }, feature: addon.feature },
          })) > 0));
    if (sameFeature) {
      throw new ConflictException({
        code: 'addon_trial_used',
        message: 'Ya has probado este extra. Para seguir usándolo, contrátalo.',
      });
    }
    const result = await this.startTrial(tenantId, addonId, SELF_ADDON_TRIAL_DAYS, {
      source: 'self',
      userId,
    });
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    await this.admin.superAdminNotification
      .create({
        data: {
          type: 'saas_addon.self_trial_started',
          title: 'Prueba gratis activada por un tenant',
          body: `${tenant?.name ?? 'Un tenant'} ha activado ${SELF_ADDON_TRIAL_DAYS} días de prueba de «${addon.name}» desde Novedades.`,
          link: `/admin/tenants/${tenantId}`,
        },
      })
      .catch(() => undefined);
    return result;
  }

  /** Funciones que incluye el plan del tenant y si su cuenta está exenta. */
  private async planContext(
    tenantId: string,
  ): Promise<{ planFeatures: TenantFeature[]; billingExempt: boolean; planSlug: string | null }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        billingExempt: true,
        subscription: { select: { plan: { select: { slug: true, tenantFeatures: true } } } },
      },
    });
    return {
      planFeatures: tenant?.subscription ? resolvePlanFeatures(tenant.subscription.plan) : [],
      billingExempt: tenant?.billingExempt ?? false,
      planSlug: tenant?.subscription?.plan.slug ?? null,
    };
  }

  /** Contratación por el tenant: solo add-ons ACTIVOS del catálogo, quantity>=1. */
  async selfAssign(tenantId: string, addonId: string, quantity = 1): Promise<TenantSelfAddonsDto> {
    // Con la cuenta suspendida por impago puede pagar y regularizar, pero no
    // contratar funciones nuevas (las tendría activas sin pagar la cuota).
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant?.status === 'suspended') {
      throw new ForbiddenException({
        code: 'tenant_suspended_read_only',
        message:
          'Tu cuenta está suspendida por un pago pendiente: regulariza el pago antes de contratar extras.',
      });
    }
    const addon = await this.findAddon(addonId);
    if (!addon.isActive) {
      throw new BadRequestException({
        code: 'addon_not_available',
        message: 'Add-on no disponible',
      });
    }
    if (
      addon.grantsAiQueries &&
      addon.grantsAiQueries > 0 &&
      !(await tenantHasFeature(this.admin, tenantId, 'ai_assistant'))
    ) {
      throw new BadRequestException({
        code: 'addon_requires_ai_assistant',
        message: 'Este extra amplía el asistente IA, que no tienes en tu plan.',
      });
    }
    const { planFeatures, planSlug } = await this.planContext(tenantId);
    if (addon.feature && planFeatures.includes(addon.feature as TenantFeature)) {
      throw new BadRequestException({
        code: 'addon_included_in_plan',
        message: 'Tu plan ya incluye este extra: no hace falta contratarlo aparte.',
      });
    }
    assertAddonAllowed(addon, planSlug, quantity);
    const existing = await this.admin.tenantSubscriptionAddon.findUnique({
      where: { tenantId_addonId: { tenantId, addonId } },
      select: { suspendedAt: true },
    });
    if (existing) {
      // Un add-on suspendido por impago NO se puede reactivar por self-service
      // (sería escapar de la deuda): solo el super admin lo reactiva al cobrar.
      if (existing.suspendedAt) {
        throw new BadRequestException({
          code: 'addon_suspended',
          message: 'Este extra está suspendido por un pago pendiente. Contacta para regularizarlo.',
        });
      }
      // Ya lo tiene contratado: re-contratar pisaría el precio congelado, la
      // cantidad o las notas que pudo fijar el super admin → 409.
      throw new ConflictException({
        code: 'addon_already_assigned',
        message: 'Ya tienes este extra contratado.',
      });
    }
    await this.assign(tenantId, { addonId, quantity });
    return this.selfServiceView(tenantId);
  }

  async selfRemove(tenantId: string, tenantAddonId: string): Promise<TenantSelfAddonsDto> {
    const existing = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      select: {
        suspendedAt: true,
        priceMonthly: true,
        quantity: true,
        notes: true,
        addon: {
          select: {
            name: true,
            priceMonthly: true,
            grantsUnits: true,
            grantsFacilities: true,
            grantsUsers: true,
            isSystem: true,
          },
        },
      },
    });
    if (!existing) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    }
    if (existing.addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Este importe depende de tus trasteros: no se quita a mano.',
      });
    }
    // No permitir que el tenant "cancele" un add-on suspendido para borrar la
    // deuda pendiente; debe regularizar primero (el admin lo quita si procede).
    if (existing.suspendedAt) {
      throw new BadRequestException({
        code: 'addon_suspended',
        message: 'Este extra está suspendido por un pago pendiente. Contacta para regularizarlo.',
      });
    }
    // Si es un add-on de capacidad y el tenant ya usa más de lo que su plan
    // permitiría sin él, no dejar cancelar (evita quedarse por encima del límite
    // sin pagar el extra que lo habilitaba).
    await this.assertCapacityRemovable(tenantId, existing);
    // Si el add-on tenía configuración especial del admin (precio negociado,
    // cantidad>1 o notas internas), avisar al super admin de la cancelación.
    await this.notifyManagedAddonRemoval(tenantId, existing);

    await this.remove(tenantId, tenantAddonId);
    return this.selfServiceView(tenantId);
  }

  /** Bloquea cancelar un add-on de capacidad si el tenant quedaría sobre el límite. */
  private async assertCapacityRemovable(
    tenantId: string,
    row: {
      quantity: number;
      addon: {
        grantsUnits: number | null;
        grantsFacilities: number | null;
        grantsUsers: number | null;
      };
    },
  ): Promise<void> {
    const grants = {
      units: (row.addon.grantsUnits ?? 0) * row.quantity,
      facilities: (row.addon.grantsFacilities ?? 0) * row.quantity,
      users: (row.addon.grantsUsers ?? 0) * row.quantity,
    };
    if (grants.units === 0 && grants.facilities === 0 && grants.users === 0) return; // no es de capacidad

    const [limits, units, facilities, activeUsers, pendingInvites] = await Promise.all([
      this.limits.resolveLimits(tenantId), // límite CON este add-on
      // Como el límite: sin los trasteros de locales borrados.
      billableUnits(this.admin, tenantId),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      this.admin.invitation.count({
        where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    const usage = { units, facilities, users: activeUsers + pendingInvites };
    const labels = { units: 'trasteros', facilities: 'locales', users: 'usuarios' } as const;
    for (const res of ['units', 'facilities', 'users'] as const) {
      const limit = limits[res];
      if (limit === null) continue; // ilimitado en el plan: cancelar no rompe nada
      const limitWithout = limit - grants[res];
      if (usage[res] > limitWithout) {
        throw new ConflictException({
          code: 'addon_capacity_in_use',
          message: `No puedes cancelar este extra: usas ${usage[res]} ${labels[res]} y sin él tu límite sería ${limitWithout}. Reduce primero o contacta con soporte.`,
          details: { resource: res, usage: usage[res], limitWithout },
        });
      }
    }
  }

  /** Avisa al super admin si el tenant cancela un add-on con config especial. */
  private async notifyManagedAddonRemoval(
    tenantId: string,
    row: {
      priceMonthly: Prisma.Decimal;
      quantity: number;
      notes: string | null;
      addon: { name: string; priceMonthly: Prisma.Decimal };
    },
  ): Promise<void> {
    const isManaged =
      row.quantity > 1 ||
      row.notes !== null ||
      num(row.priceMonthly) !== num(row.addon.priceMonthly);
    if (!isManaged) return;
    await this.admin.superAdminNotification
      .create({
        data: {
          type: 'saas_addon.self_removed',
          title: 'Extra gestionado cancelado por el tenant',
          body: `Un tenant canceló el extra «${row.addon.name}», que tenía configuración especial (precio negociado, cantidad o notas). Revísalo si procede.`,
          link: `/admin/tenants/${tenantId}`,
        },
      })
      .catch(() => undefined);
  }

  async assign(tenantId: string, input: AssignAddonInput): Promise<TenantBillingSummaryDto> {
    const addon = await this.findAddon(input.addonId);
    if (addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Este extra lo calcula la plataforma con los trasteros del cliente.',
      });
    }
    assertAddonAllowed(addon, (await this.planContext(tenantId)).planSlug, input.quantity);
    // Sin precio negociado, el del tramo que alcanza la cantidad (congelado).
    const price =
      input.priceMonthly ??
      addonUnitPrice(
        num(addon.priceMonthly),
        parseAddonPriceTiers(addon.priceTiers),
        input.quantity,
      );
    const existing = await this.admin.tenantSubscriptionAddon.findUnique({
      where: { tenantId_addonId: { tenantId, addonId: input.addonId } },
      select: {
        billingMode: true,
        stripeSubscriptionItemId: true,
        quantity: true,
        suspendedAt: true,
      },
    });
    // Un extra retirado del catálogo no se contrata de nuevo (sí se puede
    // cambiar la cantidad o el precio de quien ya lo tiene).
    if (!existing && !addon.isActive) {
      throw new BadRequestException({
        code: 'addon_not_available',
        message: 'Este extra está desactivado en el catálogo.',
      });
    }
    // Upsert: reasignar actualiza cantidad/precio (unique por tenant+addon).
    await this.admin.tenantSubscriptionAddon.upsert({
      where: { tenantId_addonId: { tenantId, addonId: input.addonId } },
      create: {
        tenantId,
        addonId: input.addonId,
        priceMonthly: price,
        quantity: input.quantity,
        notes: input.notes ?? null,
        // Programa el primer cobro para ya (aparece en la bandeja «Hoy»).
        nextChargeAt: new Date(),
      },
      // Reasignar NO reinicia el ciclo de cobro (conserva nextChargeAt); reactiva
      // si estaba suspendido. Conserva billingMode/stripeSubscriptionItemId.
      update: {
        priceMonthly: price,
        quantity: input.quantity,
        notes: input.notes ?? null,
        suspendedAt: null,
        // Si estaba suspendido, la suspensión le quitó la fecha de cobro: vuelve
        // a la bandeja «Hoy» (como al reactivarlo), si no, nunca se cobraría.
        ...(existing?.suspendedAt ? { nextChargeAt: new Date() } : {}),
      },
    });
    // Si estaba en modo Stripe y cambia la cantidad, sincroniza el subscription item.
    if (
      existing?.billingMode === 'stripe' &&
      existing.stripeSubscriptionItemId &&
      existing.quantity !== input.quantity
    ) {
      await this.syncStripeItemQuantity(existing.stripeSubscriptionItemId, input.quantity);
    }
    // Reconcilia la feature del add-on (activa el override si procede).
    await this.reconcileFeatureOverride(tenantId, addon.feature);
    return this.billingSummary(tenantId);
  }

  /**
   * Edita un extra asignado: cantidad, precio negociado, nota y próximo cobro.
   * En Stripe la cantidad se sincroniza con su línea; el precio y la fecha los
   * lleva Stripe (hay que pasarlo antes a cobro manual).
   */
  async updateAssignment(
    tenantId: string,
    tenantAddonId: string,
    input: UpdateTenantAddonInput,
  ): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: true },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    if (row.addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Este extra lo calcula la plataforma con los trasteros del cliente.',
      });
    }
    const onStripe = row.billingMode === 'stripe';
    if (
      onStripe &&
      input.priceMonthly !== undefined &&
      input.priceMonthly !== num(row.priceMonthly)
    ) {
      throw new BadRequestException({
        code: 'addon_price_on_stripe',
        message:
          'Se cobra por Stripe con el precio del catálogo: pásalo a cobro manual para negociar el precio.',
      });
    }
    if (onStripe && input.nextChargeAt !== undefined) {
      throw new BadRequestException({
        code: 'addon_date_on_stripe',
        message: 'Se cobra con la suscripción de Stripe: la fecha la pone Stripe.',
      });
    }
    if (input.quantity !== undefined && input.quantity !== row.quantity) {
      assertAddonAllowed(row.addon, (await this.planContext(tenantId)).planSlug, input.quantity);
    }
    await this.admin.tenantSubscriptionAddon.update({
      where: { id: tenantAddonId },
      data: {
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.priceMonthly !== undefined ? { priceMonthly: input.priceMonthly } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
        ...(input.nextChargeAt !== undefined
          ? {
              nextChargeAt: input.nextChargeAt
                ? new Date(`${input.nextChargeAt}T09:00:00.000Z`)
                : null,
            }
          : {}),
      },
    });
    if (
      onStripe &&
      row.stripeSubscriptionItemId &&
      input.quantity !== undefined &&
      input.quantity !== row.quantity
    ) {
      await this.syncStripeItemQuantity(row.stripeSubscriptionItemId, input.quantity);
    }
    return this.billingSummary(tenantId);
  }

  async remove(tenantId: string, tenantAddonId: string): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: { select: { feature: true, isSystem: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    if (row.addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Los trasteros de más los calcula la plataforma con los trasteros del cliente.',
      });
    }
    // Modo Stripe: borra también el subscription item (crédito prorrateado).
    if (row.billingMode === 'stripe' && row.stripeSubscriptionItemId) {
      await this.deleteStripeItem(row.stripeSubscriptionItemId);
    }
    await this.admin.tenantSubscriptionAddon.delete({ where: { id: tenantAddonId } });
    await this.reconcileFeatureOverride(tenantId, row.addon.feature);
    return this.billingSummary(tenantId);
  }

  /**
   * Suspende un add-on por impago (reversible): desactiva su feature y deja de
   * contar al MRR y a la capacidad; los datos ya creados NO se tocan. Sale de la
   * bandeja de cobros del «Hoy».
   */
  async suspend(tenantId: string, tenantAddonId: string): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: { select: { feature: true, isSystem: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    if (row.addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Los trasteros de más los calcula la plataforma con los trasteros del cliente.',
      });
    }
    if (row.suspendedAt) {
      throw new BadRequestException({ code: 'already_suspended', message: 'Ya está suspendido' });
    }
    // Si estaba en modo Stripe, se retira el subscription item (deja de cobrarse)
    // y baja a modo manual: al reactivar vuelve a la bandeja «Hoy» (el operador
    // re-activa el cobro por Stripe si quiere).
    if (row.billingMode === 'stripe' && row.stripeSubscriptionItemId) {
      await this.deleteStripeItem(row.stripeSubscriptionItemId);
    }
    // Al suspender se retira de la bandeja de cobros: limpiamos `nextChargeAt`
    // para no dejar una fecha de cobro residual (reactivar la reprograma).
    await this.admin.tenantSubscriptionAddon.update({
      where: { id: tenantAddonId },
      data: {
        suspendedAt: new Date(),
        nextChargeAt: null,
        billingMode: 'manual',
        stripeSubscriptionItemId: null,
      },
    });
    await this.reconcileFeatureOverride(tenantId, row.addon.feature);
    return this.billingSummary(tenantId);
  }

  /**
   * Enforcement de add-ons de cobro MANUAL: suspende los que llevan impagos más
   * de `suspendDays` desde su `next_charge_at` (mismo umbral que la suspensión
   * del plan). Solo actúa si el dunning del SaaS está activado (igual que la
   * suspensión del plan; sin dunning, el operador gestiona a mano desde «Hoy»).
   * Excluye exentos y los de Stripe (esos los cobra Stripe). Best-effort por
   * add-on. Devuelve cuántos suspendió.
   */
  async suspendLapsedManualAddons(now = new Date()): Promise<number> {
    const settings = await this.admin.platformDunningSettings.findFirst();
    if (!settings?.enabled) return 0;
    const cutoff = new Date(now.getTime() - settings.suspendDays * 24 * 60 * 60 * 1000);
    const lapsed = await this.admin.tenantSubscriptionAddon.findMany({
      where: {
        billingMode: { not: 'stripe' }, // manual (o legacy null); los de Stripe no
        addon: { isSystem: false }, // los trasteros de más van con la cuota
        suspendedAt: null,
        nextChargeAt: { lt: cutoff },
        // Con la cuota domiciliada por SEPA los extras van en la misma remesa:
        // su impago es el de la suscripción (lo lleva el cobro de morosos).
        tenant: {
          deletedAt: null,
          billingExempt: false,
          // Con la cuota domiciliada o cobrada sola con tarjeta, los extras van
          // en el mismo cargo.
          NOT: { subscription: { billingMode: { in: ['sepa', 'redsys'] } } },
        },
      },
      select: { id: true, tenantId: true },
    });
    let suspended = 0;
    for (const a of lapsed) {
      try {
        await this.suspend(a.tenantId, a.id);
        suspended += 1;
      } catch (err) {
        this.logger.warn(`No se pudo auto-suspender el add-on ${a.id}: ${String(err)}`);
      }
    }
    if (suspended) this.logger.log(`Auto-suspensión: ${suspended} add-ons manuales impagados`);
    return suspended;
  }

  /** Reactiva un add-on suspendido: re-activa su feature y su cobro. */
  async reactivate(tenantId: string, tenantAddonId: string): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: { select: { feature: true, isSystem: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    if (row.addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Los trasteros de más los calcula la plataforma con los trasteros del cliente.',
      });
    }
    if (!row.suspendedAt) {
      throw new BadRequestException({ code: 'not_suspended', message: 'No está suspendido' });
    }
    await this.admin.tenantSubscriptionAddon.update({
      where: { id: tenantAddonId },
      data: { suspendedAt: null, nextChargeAt: new Date() },
    });
    await this.reconcileFeatureOverride(tenantId, row.addon.feature);
    return this.billingSummary(tenantId);
  }

  // ---- cobro por Stripe (subscription items) ----

  /**
   * Cambia el modo de cobro de un add-on contratado (super admin):
   * - `stripe`: añade un subscription item a la suscripción de Stripe del tenant
   *   (Stripe prorratea), sale de la bandeja de cobros manuales del «Hoy».
   * - `manual`: retira el subscription item (crédito prorrateado) y vuelve a la
   *   bandeja «Hoy».
   * Requiere que el tenant pague el plan por Stripe (si no, 400 `tenant_not_on_stripe`).
   */
  async setBillingMode(
    tenantId: string,
    tenantAddonId: string,
    mode: AddonBillingMode,
  ): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: true },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    if (row.addon.isSystem) {
      throw new BadRequestException({
        code: 'addon_managed_by_platform',
        message: 'Los trasteros de más los calcula la plataforma con los trasteros del cliente.',
      });
    }
    if (row.suspendedAt) {
      throw new BadRequestException({
        code: 'addon_suspended',
        message: 'Regulariza el add-on suspendido antes de cambiar su cobro.',
      });
    }
    const current: AddonBillingMode = row.billingMode === 'stripe' ? 'stripe' : 'manual';
    if (current === mode) {
      throw new BadRequestException({ code: 'already_in_mode', message: 'Ya está en ese modo' });
    }

    if (mode === 'stripe') {
      this.assertStripeConfigured();
      const sub = await this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: { stripeSubscriptionId: true },
      });
      if (!sub?.stripeSubscriptionId) {
        throw new BadRequestException({
          code: 'tenant_not_on_stripe',
          message:
            'El tenant no paga el plan por Stripe; no hay suscripción donde añadir el add-on.',
        });
      }
      // Stripe cobraría el precio del catálogo: si a este tenant se le congeló
      // otro precio, el cambio le cobraría distinto de lo acordado.
      if (
        Math.round(num(row.priceMonthly) * 100) !== Math.round(num(row.addon.priceMonthly) * 100)
      ) {
        throw new BadRequestException({
          code: 'addon_price_differs',
          message: `Este tenant paga ${num(row.priceMonthly).toFixed(2)} € por el extra y la tarifa es ${num(row.addon.priceMonthly).toFixed(2)} €: Stripe cobraría la tarifa. Déjalo en cobro manual o pon el precio de tarifa.`,
        });
      }
      const priceId = await this.ensureStripePrice(row.addon);
      const item = await this.stripe.subscriptionItems.create({
        subscription: sub.stripeSubscriptionId,
        price: priceId,
        quantity: row.quantity,
        proration_behavior: 'create_prorations',
        metadata: { kind: 'addon', tenantAddonId: row.id, addonId: row.addonId },
      });
      await this.admin.tenantSubscriptionAddon.update({
        where: { id: row.id },
        // Sale de la bandeja «Hoy»: lo cobra Stripe.
        data: { billingMode: 'stripe', stripeSubscriptionItemId: item.id, nextChargeAt: null },
      });
    } else {
      if (row.stripeSubscriptionItemId) {
        await this.deleteStripeItem(row.stripeSubscriptionItemId);
      }
      await this.admin.tenantSubscriptionAddon.update({
        where: { id: row.id },
        // Vuelve a la bandeja «Hoy».
        data: { billingMode: 'manual', stripeSubscriptionItemId: null, nextChargeAt: new Date() },
      });
    }
    return this.billingSummary(tenantId);
  }

  /**
   * Asegura que el add-on del catálogo tiene un Price recurrente mensual en
   * Stripe; lo autocrea (Product + Price EUR/mes) la primera vez y persiste el
   * mapeo. Reutiliza el Price existente (precio congelado): editar el precio del
   * add-on genera un Price nuevo vía `syncStripePriceForAddon` en `updateAddon`.
   */
  private async ensureStripePrice(addon: {
    id: string;
    slug: string;
    name: string;
    priceMonthly: Prisma.Decimal;
    stripePriceId: string | null;
    stripeProductId: string | null;
  }): Promise<string> {
    if (addon.stripePriceId) return addon.stripePriceId;
    let productId = addon.stripeProductId;
    if (!productId) {
      const product = await this.stripe.products.create({
        name: `Add-on: ${addon.name}`,
        metadata: { addonId: addon.id, slug: addon.slug },
      });
      productId = product.id;
    }
    const price = await this.stripe.prices.create({
      product: productId,
      currency: 'eur',
      unit_amount: Math.round(num(addon.priceMonthly) * 100),
      recurring: { interval: 'month' },
      metadata: { addonId: addon.id },
    });
    await this.admin.subscriptionAddon.update({
      where: { id: addon.id },
      data: { stripeProductId: productId, stripePriceId: price.id },
    });
    return price.id;
  }

  /**
   * Tras editar el precio de un add-on ya mapeado a Stripe, crea un Price nuevo
   * (los Prices de Stripe son inmutables) y actualiza el mapeo. Los tenants ya en
   * modo Stripe conservan su item con el Price viejo (precio congelado); solo las
   * nuevas activaciones usarán el nuevo. Best-effort: no rompe la edición.
   */
  private async syncStripePriceForAddon(addonId: string): Promise<void> {
    if (!this.stripeGateway.isConfigured()) return;
    try {
      const addon = await this.admin.subscriptionAddon.findUnique({ where: { id: addonId } });
      if (!addon?.stripeProductId) return;
      const price = await this.stripe.prices.create({
        product: addon.stripeProductId,
        currency: 'eur',
        unit_amount: Math.round(num(addon.priceMonthly) * 100),
        recurring: { interval: 'month' },
        metadata: { addonId: addon.id },
      });
      await this.admin.subscriptionAddon.update({
        where: { id: addon.id },
        data: { stripePriceId: price.id },
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo sincronizar el Price de Stripe del add-on ${addonId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Quita la línea del extra de la suscripción de Stripe. Si Stripe no la
   * confirma, lanza: quitar, suspender o volver a manual no siguen mientras
   * Stripe la siga cobrando. Una línea que ya no existe en Stripe vale.
   */
  private async deleteStripeItem(itemId: string, prorate = true): Promise<void> {
    if (!this.stripeGateway.isConfigured()) return;
    try {
      await this.stripe.subscriptionItems.del(itemId, {
        proration_behavior: prorate ? 'create_prorations' : 'none',
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'resource_missing') return;
      this.logger.warn(
        `No se pudo borrar el subscription item ${itemId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new BadGatewayException({
        code: 'stripe_item_delete_failed',
        message:
          'Stripe no ha confirmado que deje de cobrar este extra. Vuelve a intentarlo o quítalo en el panel de Stripe.',
      });
    }
  }

  private async syncStripeItemQuantity(itemId: string, quantity: number): Promise<void> {
    try {
      await this.stripe.subscriptionItems.update(itemId, {
        quantity,
        proration_behavior: 'create_prorations',
      });
    } catch (err) {
      this.logger.warn(
        `No se pudo actualizar la cantidad del subscription item ${itemId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---- helpers ----

  /**
   * Sincroniza el override de una feature aportada por add-ons tras un cambio
   * (assign/remove/suspend/reactivate). Regla:
   * - Si ALGÚN add-on activo (no suspendido) del tenant aporta la feature →
   *   asegura el override activado (con `source='addon'` si lo crea; si ya existe
   *   una cortesía `manual`, NO cambia su origen).
   * - Si NINGÚN add-on activo la aporta → retira SOLO el override de origen
   *   `addon` (respeta las cortesías `manual` del super admin y los overrides que
   *   DESACTIVAN una feature del plan).
   * Así dos add-ons con la misma feature no se pisan, y quitar un add-on no borra
   * una cortesía ni la feature si otro add-on la sostiene.
   */
  private async reconcileFeatureOverride(tenantId: string, feature: string | null): Promise<void> {
    if (!feature || !(TenantFeatures as readonly string[]).includes(feature)) return;
    const activeWithFeature = await this.admin.tenantSubscriptionAddon.count({
      where: { tenantId, suspendedAt: null, addon: { feature } },
    });
    if (activeWithFeature > 0) {
      const existing = await this.admin.tenantFeatureOverride.findUnique({
        where: { tenantId_feature: { tenantId, feature } },
        select: { source: true, expiresAt: true },
      });
      // Una prueba gratis, o una cortesía con fecha, se convierte en el extra
      // contratado (sin caducidad): si no, al caducar le quitaría la función
      // que ya paga. Una cortesía sin fecha se respeta como está.
      const fromTrial =
        existing?.source === 'trial' || (existing?.source === 'manual' && !!existing.expiresAt);
      await this.admin.tenantFeatureOverride.upsert({
        where: { tenantId_feature: { tenantId, feature } },
        create: { tenantId, feature, enabled: true, source: 'addon' },
        update: fromTrial
          ? {
              enabled: true,
              source: 'addon',
              expiresAt: null,
              trialAddonId: null,
              expiryNotifiedAt: null,
            }
          : { enabled: true },
      });
    } else {
      await this.admin.tenantFeatureOverride.deleteMany({
        where: { tenantId, feature, source: 'addon' },
      });
    }
  }

  private validateFeature(feature: string | undefined): void {
    if (feature && feature !== '' && !(TenantFeatures as readonly string[]).includes(feature)) {
      throw new BadRequestException({ code: 'invalid_feature', message: 'Feature desconocida' });
    }
  }

  private async findAddon(id: string) {
    const addon = await this.admin.subscriptionAddon.findUnique({ where: { id } });
    if (!addon)
      throw new NotFoundException({ code: 'addon_not_found', message: 'Add-on no encontrado' });
    return addon;
  }

  private toCatalogDto(r: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    priceMonthly: Prisma.Decimal;
    feature: string | null;
    grantsUnits: number | null;
    grantsFacilities: number | null;
    grantsUsers: number | null;
    grantsAiQueries: number | null;
    stripePriceId: string | null;
    priceTiers?: Prisma.JsonValue;
    planSlugs?: string[];
    maxQuantity?: number | null;
    isSystem?: boolean;
    isActive: boolean;
  }): SaasAddonDto {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      priceMonthly: num(r.priceMonthly),
      feature: r.feature,
      grantsUnits: r.grantsUnits,
      grantsFacilities: r.grantsFacilities,
      grantsUsers: r.grantsUsers,
      grantsAiQueries: r.grantsAiQueries,
      planSlugs: r.planSlugs ?? [],
      maxQuantity: r.maxQuantity ?? null,
      isSystem: r.isSystem ?? false,
      isActive: r.isActive,
      stripePriceId: r.stripePriceId,
      priceTiers: parseAddonPriceTiers(r.priceTiers ?? null),
      tenantCount: 0,
    };
  }

  private toTenantAddonDto(r: {
    id: string;
    addonId: string;
    priceMonthly: Prisma.Decimal;
    quantity: number;
    notes: string | null;
    suspendedAt: Date | null;
    billingMode: string;
    addon: { name: string; slug: string; feature: string | null; isSystem?: boolean };
  }): TenantAddonDto {
    const price = num(r.priceMonthly);
    return {
      id: r.id,
      addonId: r.addonId,
      name: r.addon.name,
      slug: r.addon.slug,
      priceMonthly: price,
      quantity: r.quantity,
      lineTotal: round2(price * r.quantity),
      feature: r.addon.feature,
      notes: r.notes,
      suspended: r.suspendedAt !== null,
      billingMode: r.billingMode === 'stripe' ? 'stripe' : 'manual',
      isSystem: r.addon.isSystem ?? false,
    };
  }
}
