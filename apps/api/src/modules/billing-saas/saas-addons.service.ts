import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantFeatures } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

import type { Prisma } from '@storageos/database';
import type {
  AssignAddonInput,
  SaasAddonDto,
  TenantAddonDto,
  TenantBillingSummaryDto,
  TenantLimitsDto,
  TenantSelfAddonsDto,
  UpsertSaasAddonInput,
} from '@storageos/shared';

const num = (d: Prisma.Decimal | number): number => Number(d);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Motor de add-ons facturables del SaaS. `subscription_addons` es el catálogo
 * GLOBAL (como subscription_plans); `tenant_subscription_addons` son los
 * contratados por cada tenant. v1 desacoplado de Stripe: el importe efectivo
 * (plan + add-ons) alimenta las métricas y el importe sugerido del pago manual.
 * Asignar un add-on con `feature` activa el override de esa feature del tenant.
 */
@Injectable()
export class SaasAddonsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly limits: PlanLimitsService,
  ) {}

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
    const rows = await this.admin.subscriptionAddon.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toCatalogDto(r));
  }

  async createAddon(input: UpsertSaasAddonInput): Promise<SaasAddonDto> {
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
        isActive: input.isActive,
      },
    });
    return this.toCatalogDto(created);
  }

  async updateAddon(id: string, input: UpsertSaasAddonInput): Promise<SaasAddonDto> {
    this.validateFeature(input.feature);
    await this.findAddon(id);
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
        isActive: input.isActive,
      },
    });
    return this.toCatalogDto(updated);
  }

  // ---- por tenant ----

  async billingSummary(tenantId: string): Promise<TenantBillingSummaryDto> {
    const [subscription, addons] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { name: true, priceMonthly: true } } },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId },
        include: { addon: { select: { name: true, slug: true, feature: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const planMonthly = subscription ? num(subscription.plan.priceMonthly) : 0;
    const addonDtos = addons.map((a) => this.toTenantAddonDto(a));
    const addonsMonthly = round2(addonDtos.reduce((s, a) => s + a.lineTotal, 0));
    return {
      planName: subscription?.plan.name ?? null,
      planMonthly,
      addons: addonDtos,
      addonsMonthly,
      effectiveMonthly: round2(planMonthly + addonsMonthly),
    };
  }

  /** MRR mensual de los add-ons de un tenant (para métricas). */
  async addonsMonthly(tenantId: string): Promise<number> {
    const addons = await this.admin.tenantSubscriptionAddon.findMany({
      where: { tenantId },
      select: { priceMonthly: true, quantity: true },
    });
    return round2(addons.reduce((s, a) => s + num(a.priceMonthly) * a.quantity, 0));
  }

  /** MRR mensual de los add-ons de TODOS los tenants (para el MRR global). */
  async addonsMonthlyByTenant(): Promise<Map<string, number>> {
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      select: { tenantId: true, priceMonthly: true, quantity: true },
    });
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.tenantId, (map.get(r.tenantId) ?? 0) + num(r.priceMonthly) * r.quantity);
    }
    return map;
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
    const available = catalog.filter((a) => !owned.has(a.id)).map((a) => this.toCatalogDto(a));
    return { summary, available };
  }

  /** Contratación por el tenant: solo add-ons ACTIVOS del catálogo, quantity>=1. */
  async selfAssign(tenantId: string, addonId: string, quantity = 1): Promise<TenantSelfAddonsDto> {
    const addon = await this.findAddon(addonId);
    if (!addon.isActive) {
      throw new BadRequestException({
        code: 'addon_not_available',
        message: 'Add-on no disponible',
      });
    }
    await this.assign(tenantId, { addonId, quantity });
    return this.selfServiceView(tenantId);
  }

  async selfRemove(tenantId: string, tenantAddonId: string): Promise<TenantSelfAddonsDto> {
    await this.remove(tenantId, tenantAddonId);
    return this.selfServiceView(tenantId);
  }

  async assign(tenantId: string, input: AssignAddonInput): Promise<TenantBillingSummaryDto> {
    const addon = await this.findAddon(input.addonId);
    const price = input.priceMonthly ?? num(addon.priceMonthly);
    // Upsert: reasignar actualiza cantidad/precio (unique por tenant+addon).
    await this.admin.tenantSubscriptionAddon.upsert({
      where: { tenantId_addonId: { tenantId, addonId: input.addonId } },
      create: {
        tenantId,
        addonId: input.addonId,
        priceMonthly: price,
        quantity: input.quantity,
        notes: input.notes ?? null,
      },
      update: { priceMonthly: price, quantity: input.quantity, notes: input.notes ?? null },
    });
    // Activa la feature del add-on (override) si la tiene.
    if (addon.feature && (TenantFeatures as readonly string[]).includes(addon.feature)) {
      await this.admin.tenantFeatureOverride.upsert({
        where: { tenantId_feature: { tenantId, feature: addon.feature } },
        create: { tenantId, feature: addon.feature, enabled: true },
        update: { enabled: true },
      });
    }
    return this.billingSummary(tenantId);
  }

  async remove(tenantId: string, tenantAddonId: string): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: { select: { feature: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    await this.admin.tenantSubscriptionAddon.delete({ where: { id: tenantAddonId } });
    // Retira el override de feature (la feature vuelve a depender del plan).
    if (row.addon.feature) {
      await this.admin.tenantFeatureOverride.deleteMany({
        where: { tenantId, feature: row.addon.feature, enabled: true },
      });
    }
    return this.billingSummary(tenantId);
  }

  // ---- helpers ----

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
      isActive: r.isActive,
    };
  }

  private toTenantAddonDto(r: {
    id: string;
    addonId: string;
    priceMonthly: Prisma.Decimal;
    quantity: number;
    notes: string | null;
    addon: { name: string; slug: string; feature: string | null };
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
    };
  }
}
