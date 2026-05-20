import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';
import type { SubscriptionPlanDto, UpsertSubscriptionPlanFormInput } from '@storageos/shared';

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
@Injectable()
export class SubscriptionPlansService {
  constructor(private readonly admin: PrismaAdminService) {}

  /** Lista solo planes activos. Util para landing/pricing publica. */
  async list(): Promise<SubscriptionPlanDto[]> {
    const rows = await this.admin.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: [{ priceMonthly: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  /** Lista TODOS los planes (incluye inactivos). Solo admin. */
  async listAll(): Promise<SubscriptionPlanDto[]> {
    const rows = await this.admin.subscriptionPlan.findMany({
      orderBy: [{ priceMonthly: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  async getById(planId: string): Promise<SubscriptionPlanDto> {
    const row = await this.admin.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!row) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    return this.toDto(row);
  }

  async create(input: UpsertSubscriptionPlanFormInput): Promise<SubscriptionPlanDto> {
    const row = await this.admin.subscriptionPlan.create({
      data: {
        slug: input.slug,
        name: input.name,
        priceMonthly: input.priceMonthly,
        priceYearly: input.priceYearly,
        features: (input.features ?? {}) as Prisma.InputJsonValue,
        ...(input.stripePriceId !== undefined ? { stripePriceId: input.stripePriceId } : {}),
        ...(input.maxUnits !== undefined ? { maxUnits: input.maxUnits } : {}),
        ...(input.maxFacilities !== undefined ? { maxFacilities: input.maxFacilities } : {}),
        ...(input.maxUsers !== undefined ? { maxUsers: input.maxUsers } : {}),
        isActive: input.isActive ?? true,
      },
    });
    return this.toDto(row);
  }

  async update(
    planId: string,
    input: {
      [K in keyof UpsertSubscriptionPlanFormInput]?: UpsertSubscriptionPlanFormInput[K];
    },
  ): Promise<SubscriptionPlanDto> {
    const existing = await this.admin.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!existing) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
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
        ...(input.stripePriceId !== undefined ? { stripePriceId: input.stripePriceId } : {}),
        ...(input.maxUnits !== undefined ? { maxUnits: input.maxUnits } : {}),
        ...(input.maxFacilities !== undefined ? { maxFacilities: input.maxFacilities } : {}),
        ...(input.maxUsers !== undefined ? { maxUsers: input.maxUsers } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
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
    await this.admin.subscriptionPlan.update({
      where: { id: planId },
      data: { isActive: false },
    });
  }

  private toDto(row: {
    id: string;
    slug: string;
    name: string;
    priceMonthly: { toString(): string } | number;
    features: unknown;
    stripePriceId: string | null;
    isActive: boolean;
  }): SubscriptionPlanDto {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: null,
      priceMonthly: Number(row.priceMonthly.toString()),
      currency: 'EUR',
      features: (row.features ?? {}) as Record<string, unknown>,
      stripePriceId: row.stripePriceId,
      isActive: row.isActive,
    };
  }
}
