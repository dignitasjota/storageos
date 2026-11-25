import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { todayInTimezone } from '../../common/format';
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
/** Planes grandes: al llegar al tope de trasteros se ofrece un precio a medida. */
const CUSTOM_PRICING_PLANS = new Set(['pro', 'administrador']);

const RESOURCE_NAMES: Record<LimitResource, string> = {
  units: 'trasteros',
  facilities: 'locales',
  users: 'usuarios',
};

/** Qué decirle a quien llega al límite de su plan. */
export function limitMessage(
  planSlug: string | null,
  resource: LimitResource,
  limit: number,
): string {
  const what = `${limit.toLocaleString('es-ES')} ${RESOURCE_NAMES[resource]}`;
  if (planSlug === 'basic') {
    return resource === 'users'
      ? `Tu plan Basic incluye ${what}. Añade el segundo usuario en Suscripción o pasa a Starter.`
      : `Tu plan Basic llega hasta ${what}. Pasa a Starter para seguir creciendo.`;
  }
  if (CUSTOM_PRICING_PLANS.has(planSlug ?? '')) {
    return resource === 'units'
      ? `Has llegado a ${what}, el máximo de tu plan. Te contactaremos para darte un precio a medida; si lo prefieres, escríbenos desde Soporte.`
      : `Has llegado a ${what}, el máximo de tu plan. Escríbenos desde Soporte y lo ampliamos.`;
  }
  return 'Has alcanzado el límite de tu plan. Amplíalo con un extra o sube de plan.';
}

@Injectable()
export class PlanLimitsService {
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /**
   * Un cliente de un plan grande llega al tope de trasteros: seguimiento para
   * contactarle y darle un precio a medida (de su comercial, si lo tiene) y
   * aviso al equipo. Una sola vez mientras el seguimiento siga pendiente.
   */
  private async flagCustomPricing(
    tenantId: string,
    planName: string,
    limit: number,
  ): Promise<void> {
    const title = 'Precio a medida: ha llegado al máximo de trasteros';
    const open = await this.admin.tenantFollowup.count({
      where: { tenantId, status: 'pending', title },
    });
    if (open > 0) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, salesRep: { select: { fullName: true } } },
    });
    if (!tenant) return;
    // Sin asignar: un comercial no ve los seguimientos de los tenants; su nombre
    // va en la nota para que la dirección se lo pase.
    const note = `Tiene el plan ${planName} y ha intentado pasar de ${limit.toLocaleString('es-ES')} trasteros. Contactar para darle un precio a medida (se amplía con un extra que dé más trasteros).${
      tenant.salesRep ? ` Lo lleva el comercial ${tenant.salesRep.fullName}.` : ''
    }`;
    await this.admin.tenantFollowup.create({
      data: {
        tenantId,
        title,
        note,
        // Hoy en hora de España (a medianoche en UTC sería aún el día anterior).
        dueDate: todayInTimezone('Europe/Madrid'),
      },
    });
    await this.admin.superAdminNotification.create({
      data: {
        type: 'tenant.custom_pricing',
        title: `${tenant.name} necesita un precio a medida`,
        body: note,
        link: `/admin/tenants/${tenantId}`,
      },
    });
  }

  /** Límites efectivos = plan + Σ(add-on.grants × quantity). null = ilimitado. */
  async resolveLimits(tenantId: string): Promise<EffectiveLimits> {
    const [subscription, addons] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: {
          plan: { select: { slug: true, maxUnits: true, maxFacilities: true, maxUsers: true } },
        },
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
      const sub = await this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: { plan: { select: { slug: true, name: true } } },
      });
      if (resource === 'units' && sub && CUSTOM_PRICING_PLANS.has(sub.plan.slug)) {
        // Avisamos al equipo para contactar con él y darle un precio a medida.
        await this.flagCustomPricing(tenantId, sub.plan.name, limit).catch((err: unknown) =>
          this.logger.warn(`[límites] aviso de precio a medida (${tenantId}): ${String(err)}`),
        );
      }
      throw new ForbiddenException({
        code: `${resource}_limit_reached`,
        message: limitMessage(sub?.plan.slug ?? null, resource, limit),
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
