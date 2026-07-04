import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantFeatures } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';

import type { Prisma } from '@storageos/database';
import type {
  AdminAddonAnalyticsDto,
  AssignAddonInput,
  SaasAddonDto,
  TenantAddonDto,
  TenantBillingStatusDto,
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

  /** Estado de cuenta del tenant: pagos pendientes (plan past_due + add-ons suspendidos). */
  async billingStatus(tenantId: string): Promise<TenantBillingStatusDto> {
    const [subscription, suspended] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: { status: true },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId, suspendedAt: { not: null } },
        select: { addon: { select: { name: true, feature: true } } },
      }),
    ]);
    const pastDue = subscription?.status === 'past_due';
    const suspendedAddons = suspended.map((s) => ({
      name: s.addon.name,
      feature: s.addon.feature,
    }));
    const suspendedFeatures = suspendedAddons
      .map((a) => a.feature)
      .filter((f): f is string => f !== null);
    return {
      pastDue,
      suspendedAddons,
      suspendedFeatures,
      hasIssue: pastDue || suspendedAddons.length > 0,
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
    const rows = await this.admin.subscriptionAddon.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toCatalogDto(r));
  }

  /**
   * Analítica global del catálogo (cross-tenant): por cada add-on, cuántos
   * tenants lo tienen activo/suspendido y su MRR. Para decisiones de producto
   * (adopción, candidatos a discontinuar).
   */
  async catalogAnalytics(): Promise<AdminAddonAnalyticsDto[]> {
    const [catalog, assignments] = await Promise.all([
      this.admin.subscriptionAddon.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
      this.admin.tenantSubscriptionAddon.findMany({
        select: { addonId: true, priceMonthly: true, quantity: true, suspendedAt: true },
      }),
    ]);
    const stats = new Map<string, { active: number; suspended: number; revenue: number }>();
    for (const a of assignments) {
      const e = stats.get(a.addonId) ?? { active: 0, suspended: 0, revenue: 0 };
      if (a.suspendedAt) {
        e.suspended += 1;
      } else {
        e.active += 1;
        e.revenue += num(a.priceMonthly) * a.quantity;
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
    const current = await this.findAddon(id);
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
    // Los suspendidos se muestran (para reactivarlos) pero NO suman al total.
    const addonsMonthly = round2(
      addonDtos.filter((a) => !a.suspended).reduce((s, a) => s + a.lineTotal, 0),
    );
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
      where: { tenantId, suspendedAt: null },
      select: { priceMonthly: true, quantity: true },
    });
    return round2(addons.reduce((s, a) => s + num(a.priceMonthly) * a.quantity, 0));
  }

  /** MRR mensual de los add-ons de TODOS los tenants (para el MRR global). */
  async addonsMonthlyByTenant(): Promise<Map<string, number>> {
    const rows = await this.admin.tenantSubscriptionAddon.findMany({
      where: { suspendedAt: null },
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
    // Las `notes` de la asignación son internas del super admin: no exponerlas al
    // tenant en su self-service.
    const tenantSummary = {
      ...summary,
      addons: summary.addons.map((a) => ({ ...a, notes: null })),
    };
    return { summary: tenantSummary, available };
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
          },
        },
      },
    });
    if (!existing) {
      throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
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
      this.admin.unit.count({ where: { tenantId } }),
      this.admin.facility.count({ where: { tenantId, deletedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true } }),
      this.admin.invitation.count({ where: { tenantId, acceptedAt: null, revokedAt: null } }),
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
        // Programa el primer cobro para ya (aparece en la bandeja «Hoy»).
        nextChargeAt: new Date(),
      },
      // Reasignar NO reinicia el ciclo de cobro (conserva nextChargeAt); reactiva
      // si estaba suspendido.
      update: {
        priceMonthly: price,
        quantity: input.quantity,
        notes: input.notes ?? null,
        suspendedAt: null,
      },
    });
    // Reconcilia la feature del add-on (activa el override si procede).
    await this.reconcileFeatureOverride(tenantId, addon.feature);
    return this.billingSummary(tenantId);
  }

  async remove(tenantId: string, tenantAddonId: string): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: { select: { feature: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
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
      include: { addon: { select: { feature: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
    if (row.suspendedAt) {
      throw new BadRequestException({ code: 'already_suspended', message: 'Ya está suspendido' });
    }
    // Al suspender se retira de la bandeja de cobros: limpiamos `nextChargeAt`
    // para no dejar una fecha de cobro residual (reactivar la reprograma).
    await this.admin.tenantSubscriptionAddon.update({
      where: { id: tenantAddonId },
      data: { suspendedAt: new Date(), nextChargeAt: null },
    });
    await this.reconcileFeatureOverride(tenantId, row.addon.feature);
    return this.billingSummary(tenantId);
  }

  /** Reactiva un add-on suspendido: re-activa su feature y su cobro. */
  async reactivate(tenantId: string, tenantAddonId: string): Promise<TenantBillingSummaryDto> {
    const row = await this.admin.tenantSubscriptionAddon.findFirst({
      where: { id: tenantAddonId, tenantId },
      include: { addon: { select: { feature: true } } },
    });
    if (!row) throw new NotFoundException({ code: 'addon_not_found', message: 'No asignado' });
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
      await this.admin.tenantFeatureOverride.upsert({
        where: { tenantId_feature: { tenantId, feature } },
        create: { tenantId, feature, enabled: true, source: 'addon' },
        update: { enabled: true },
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
    suspendedAt: Date | null;
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
      suspended: r.suspendedAt !== null,
    };
  }
}
