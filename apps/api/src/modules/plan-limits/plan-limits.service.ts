import { ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';
import type { TenantLimitsDto } from '@storageos/shared';

export type LimitResource = 'units' | 'facilities' | 'users';

/** Clave del advisory lock por recurso (junto al hash del tenant). */
const LOCK_KEY_BY_RESOURCE: Record<LimitResource, number> = {
  units: 1,
  facilities: 2,
  users: 3,
};

interface EffectiveLimits {
  units: number | null;
  facilities: number | null;
  users: number | null;
}

/**
 * Enforcement de los límites del plan (maxUnits/maxFacilities/maxUsers),
 * ampliados por los add-ons de capacidad (`grantsUnits`… × quantity). `null` =
 * ilimitado. El plan `pro` / slug desconocido no limita (los límites son
 * `null`). Se consulta con `PrismaAdminService` (subscription + add-ons son
 * globales); el conteo actual lo pasa el caller (que ya está en su tenant).
 */
@Injectable()
export class PlanLimitsService {
  constructor(private readonly admin: PrismaAdminService) {}

  /** Límites efectivos = plan + Σ(add-on.grants × quantity). null = ilimitado. */
  async resolveLimits(tenantId: string): Promise<EffectiveLimits> {
    const [subscription, addons] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { maxUnits: true, maxFacilities: true, maxUsers: true } } },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        // Los add-ons suspendidos por impago no amplían el límite.
        where: { tenantId, suspendedAt: null },
        select: {
          quantity: true,
          addon: {
            select: { grantsUnits: true, grantsFacilities: true, grantsUsers: true },
          },
        },
      }),
    ]);

    const base = {
      units: subscription?.plan.maxUnits ?? null,
      facilities: subscription?.plan.maxFacilities ?? null,
      users: subscription?.plan.maxUsers ?? null,
    };

    // Si un recurso es ilimitado en el plan (null), sigue ilimitado. Si tiene un
    // tope, los add-ons de capacidad lo amplían.
    let extraUnits = 0;
    let extraFacilities = 0;
    let extraUsers = 0;
    for (const a of addons) {
      extraUnits += (a.addon.grantsUnits ?? 0) * a.quantity;
      extraFacilities += (a.addon.grantsFacilities ?? 0) * a.quantity;
      extraUsers += (a.addon.grantsUsers ?? 0) * a.quantity;
    }

    return {
      units: base.units === null ? null : base.units + extraUnits,
      facilities: base.facilities === null ? null : base.facilities + extraFacilities,
      users: base.users === null ? null : base.users + extraUsers,
    };
  }

  /**
   * Lanza 403 `<resource>_limit_reached` si crear un recurso más superaría el
   * límite efectivo. `currentCount` es el nº actual del recurso en el tenant.
   */
  async assertCanCreate(
    tenantId: string,
    resource: LimitResource,
    currentCount: number,
  ): Promise<void> {
    const limits = await this.resolveLimits(tenantId);
    const limit = limits[resource];
    if (limit !== null && currentCount >= limit) {
      throw new ForbiddenException({
        code: `${resource}_limit_reached`,
        message: 'Has alcanzado el límite de tu plan. Amplíalo con un add-on o sube de plan.',
        details: { resource, limit, current: currentCount },
      });
    }
  }

  /**
   * Toma un advisory lock por (tenant, recurso) DENTRO de la transacción de
   * creación para serializar las creaciones concurrentes del mismo recurso y
   * cerrar la ventana TOCTOU entre contar el uso y crear (dos requests
   * simultáneos podrían leer el mismo conteo y ambos superar el límite). El
   * lock es a nivel de transacción: se libera solo al hacer commit/rollback,
   * así que el segundo request no cuenta hasta que el primero termina y su
   * `insert` ya es visible.
   */
  async lockForCreate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    resource: LimitResource,
  ): Promise<void> {
    // `hashtext` devuelve int4; el segundo argumento se castea a int4 porque
    // Prisma envía el number JS como bigint y no existe la firma (int4, int8).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), ${LOCK_KEY_BY_RESOURCE[resource]}::int4)`;
  }

  /** Límites + uso actual (para mostrarlos en el panel). */
  async getUsage(
    tenantId: string,
    counts: Record<LimitResource, number>,
  ): Promise<TenantLimitsDto> {
    const limits = await this.resolveLimits(tenantId);
    return {
      units: { limit: limits.units, used: counts.units },
      facilities: { limit: limits.facilities, used: counts.facilities },
      users: { limit: limits.users, used: counts.users },
    };
  }
}
