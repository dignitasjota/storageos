import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PLAN_FEATURES, normalizePlanFeatures } from '@storageos/shared';

import { PAYING_SUBSCRIPTION_WHERE } from '../../common/saas-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { CatalogPriceHistoryService } from './catalog-price-history.service';
import { platformPricing } from './platform-pricing';

import type { Prisma } from '@storageos/database';
import type {
  PlanPricePreviewDto,
  SubscriptionPlanDto,
  UpsertSubscriptionPlanFormInput,
} from '@storageos/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Servicio CRUD de planes de suscripcion SaaS.
 *
 * `subscription_plans` es una tabla GLOBAL (sin tenant_id, sin RLS) — el
 * patron descrito en `schema.prisma`. Usamos `PrismaAdminService` para todas
 * las operaciones porque:
 *   - los endpoints publicos (landing /pricing) no tienen tenant context;
 *   - los endpoints admin (panel super admin) tampoco operan dentro de un
 *     tenant.
 */
/**
 * Planes de los que depende el código: el registro y «Ampliar prueba» usan
 * `starter` y el fin de la prueba o un plan gratis usa `free`. No se pueden
 * desactivar ni renombrar.
 */
const REQUIRED_PLAN_SLUGS = new Set(['free', 'starter']);
/** Planes sembrados: su slug es la clave del mapa de funciones del código. */
const SEEDED_PLAN_SLUGS = new Set(Object.keys(PLAN_FEATURES));

@Injectable()
export class SubscriptionPlansService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly priceHistory: CatalogPriceHistoryService,
  ) {}

  /** Planes activos y públicos: la web y el autoservicio del tenant. */
  async list(): Promise<SubscriptionPlanDto[]> {
    const rows = await this.admin.subscriptionPlan.findMany({
      where: { isActive: true, isPublic: true },
      orderBy: [{ priceMonthly: 'asc' }],
    });
    const { includeVat } = await platformPricing(this.admin);
    return rows.map((r) => ({ ...this.toDto(r), pricesIncludeVat: includeVat }));
  }

  /** Lista TODOS los planes (incluye inactivos y ocultos) con sus tenants y MRR. Solo admin. */
  async listAll(): Promise<SubscriptionPlanDto[]> {
    const [rows, all, paying] = await Promise.all([
      this.admin.subscriptionPlan.findMany({ orderBy: [{ priceMonthly: 'asc' }] }),
      this.admin.tenantSubscription.groupBy({
        by: ['planId'],
        where: { tenant: { deletedAt: null } },
        _count: { _all: true },
      }),
      this.admin.tenantSubscription.groupBy({
        by: ['planId'],
        where: PAYING_SUBSCRIPTION_WHERE,
        _count: { _all: true },
      }),
    ]);
    const { includeVat } = await platformPricing(this.admin);
    const allBy = new Map(all.map((g) => [g.planId, g._count._all]));
    const payingBy = new Map(paying.map((g) => [g.planId, g._count._all]));
    return rows.map((r) => {
      const payingTenants = payingBy.get(r.id) ?? 0;
      return {
        ...this.toDto(r),
        pricesIncludeVat: includeVat,
        tenantCount: allBy.get(r.id) ?? 0,
        payingTenants,
        mrr: round2(payingTenants * Number(r.priceMonthly)),
      };
    });
  }

  /**
   * Qué pasaría al cambiar el precio de un plan: tenants afectados y MRR. Los
   * que pagan por Stripe siguen con su Price hasta que se cambie en Stripe.
   */
  async pricePreview(planId: string, newPriceMonthly: number): Promise<PlanPricePreviewDto> {
    const plan = await this.admin.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    const [tenants, payingSubs] = await Promise.all([
      this.admin.tenantSubscription.count({ where: { planId, tenant: { deletedAt: null } } }),
      this.admin.tenantSubscription.findMany({
        where: { ...PAYING_SUBSCRIPTION_WHERE, planId },
        select: { stripeSubscriptionId: true },
      }),
    ]);
    const payingTenants = payingSubs.length;
    const stripeTenants = payingSubs.filter((s) => s.stripeSubscriptionId).length;
    const currentMrr = round2(payingTenants * Number(plan.priceMonthly));
    // Los de Stripe siguen pagando el precio antiguo: solo cambia el resto.
    const newMrr = round2(
      stripeTenants * Number(plan.priceMonthly) + (payingTenants - stripeTenants) * newPriceMonthly,
    );
    return {
      planId,
      tenants,
      payingTenants,
      stripeTenants,
      currentMrr,
      newMrr,
      delta: round2(newMrr - currentMrr),
    };
  }

  async getById(planId: string): Promise<SubscriptionPlanDto> {
    const row = await this.admin.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!row) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    return this.toDto(row);
  }

  async create(
    input: UpsertSubscriptionPlanFormInput,
    superAdminId: string | null = null,
  ): Promise<SubscriptionPlanDto> {
    const clash = await this.admin.subscriptionPlan.findUnique({ where: { slug: input.slug } });
    if (clash) throw new BadRequestException({ code: 'slug_taken', message: 'Ese slug ya existe' });
    const row = await this.admin.subscriptionPlan.create({
      data: {
        slug: input.slug,
        name: input.name,
        priceMonthly: input.priceMonthly,
        priceYearly: input.priceYearly,
        features: (input.features ?? {}) as Prisma.InputJsonValue,
        tenantFeatures: input.tenantFeatures ?? [],
        ...(input.stripePriceId !== undefined ? { stripePriceId: input.stripePriceId } : {}),
        ...(input.stripePriceIdYearly !== undefined
          ? { stripePriceIdYearly: input.stripePriceIdYearly }
          : {}),
        ...(input.maxUnits !== undefined ? { maxUnits: input.maxUnits } : {}),
        ...(input.maxFacilities !== undefined ? { maxFacilities: input.maxFacilities } : {}),
        ...(input.maxUsers !== undefined ? { maxUsers: input.maxUsers } : {}),
        isActive: input.isActive ?? true,
        isPublic: input.isPublic ?? true,
      },
    });
    await this.priceHistory.record({
      kind: 'plan',
      itemId: row.id,
      itemName: row.name,
      oldMonthly: null,
      newMonthly: Number(row.priceMonthly),
      oldYearly: null,
      newYearly: Number(row.priceYearly),
      superAdminId,
    });
    return this.toDto(row);
  }

  async update(
    planId: string,
    input: {
      [K in keyof UpsertSubscriptionPlanFormInput]?: UpsertSubscriptionPlanFormInput[K];
    },
    superAdminId: string | null = null,
  ): Promise<SubscriptionPlanDto> {
    const existing = await this.admin.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!existing) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    if (input.slug !== undefined && input.slug !== existing.slug) {
      if (SEEDED_PLAN_SLUGS.has(existing.slug)) {
        throw new BadRequestException({
          code: 'plan_slug_locked',
          message: 'El identificador de este plan lo usa la aplicación: no se puede cambiar.',
        });
      }
      const clash = await this.admin.subscriptionPlan.findUnique({ where: { slug: input.slug } });
      if (clash) {
        throw new BadRequestException({ code: 'slug_taken', message: 'Ese slug ya existe' });
      }
    }
    if (input.isActive === false && existing.isActive) await this.assertCanDeactivate(existing);
    const row = await this.admin.subscriptionPlan.update({
      where: { id: planId },
      data: {
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.priceMonthly !== undefined ? { priceMonthly: input.priceMonthly } : {}),
        ...(input.priceYearly !== undefined ? { priceYearly: input.priceYearly } : {}),
        ...(input.features !== undefined
          ? { features: input.features as Prisma.InputJsonValue }
          : {}),
        ...(input.tenantFeatures !== undefined ? { tenantFeatures: input.tenantFeatures } : {}),
        ...(input.stripePriceId !== undefined ? { stripePriceId: input.stripePriceId } : {}),
        ...(input.stripePriceIdYearly !== undefined
          ? { stripePriceIdYearly: input.stripePriceIdYearly }
          : {}),
        ...(input.maxUnits !== undefined ? { maxUnits: input.maxUnits } : {}),
        ...(input.maxFacilities !== undefined ? { maxFacilities: input.maxFacilities } : {}),
        ...(input.maxUsers !== undefined ? { maxUsers: input.maxUsers } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
      },
    });
    await this.priceHistory.record({
      kind: 'plan',
      itemId: row.id,
      itemName: row.name,
      oldMonthly: Number(existing.priceMonthly),
      newMonthly: Number(row.priceMonthly),
      oldYearly: Number(existing.priceYearly),
      newYearly: Number(row.priceYearly),
      superAdminId,
    });
    return this.toDto(row);
  }

  /** Soft delete: marca el plan como inactivo. No se borra fisicamente
   * porque podria seguir referenciado por `tenant_subscriptions`. */
  async deactivate(planId: string): Promise<void> {
    const existing = await this.admin.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!existing) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    await this.assertCanDeactivate(existing);
    await this.admin.subscriptionPlan.update({
      where: { id: planId },
      data: { isActive: false },
    });
  }

  /**
   * Un plan con tenants no se desactiva: dejarían de poder renovar o cambiar
   * desde su panel. Hay que pasarlos antes a otro plan.
   */
  private async assertCanDeactivate(plan: { id: string; slug: string }): Promise<void> {
    const slug = plan.slug;
    if (!REQUIRED_PLAN_SLUGS.has(slug)) {
      const inUse = await this.admin.tenantSubscription.count({
        where: { planId: plan.id, tenant: { deletedAt: null, status: { not: 'cancelled' } } },
      });
      if (inUse > 0) {
        throw new ConflictException({
          code: 'plan_in_use',
          message: `Hay ${inUse} ${inUse === 1 ? 'tenant' : 'tenants'} en este plan: pásalos antes a otro.`,
          details: { tenants: inUse },
        });
      }
      return;
    }
    throw new BadRequestException({
      code: 'plan_required',
      message:
        slug === 'free'
          ? 'El plan Free es al que pasan las pruebas que terminan: no se puede desactivar.'
          : 'Las cuentas nuevas empiezan la prueba con este plan: no se puede desactivar.',
    });
  }

  private toDto(row: {
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    priceMonthly: { toString(): string } | number;
    priceYearly?: { toString(): string } | number;
    currency?: string;
    features: unknown;
    tenantFeatures?: string[];
    stripePriceId: string | null;
    stripePriceIdYearly?: string | null;
    maxUnits?: number | null;
    maxFacilities?: number | null;
    maxUsers?: number | null;
    isActive: boolean;
    isPublic?: boolean;
  }): SubscriptionPlanDto {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description ?? null,
      priceMonthly: Number(row.priceMonthly.toString()),
      priceYearly: row.priceYearly !== undefined ? Number(row.priceYearly.toString()) : 0,
      currency: row.currency ?? 'EUR',
      features: (row.features ?? {}) as Record<string, unknown>,
      tenantFeatures: normalizePlanFeatures(row.tenantFeatures),
      stripePriceId: row.stripePriceId,
      stripePriceIdYearly: row.stripePriceIdYearly ?? null,
      maxUnits: row.maxUnits ?? null,
      maxFacilities: row.maxFacilities ?? null,
      maxUsers: row.maxUsers ?? null,
      isActive: row.isActive,
      isPublic: row.isPublic ?? true,
    };
  }
}
