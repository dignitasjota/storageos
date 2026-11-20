import { Injectable, NotFoundException } from '@nestjs/common';
import { rentTax } from '@storageos/shared';

import { tenantReadiness, webPublished } from '../../common/tenant-readiness';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { LeadsService } from '../leads/leads.service';

import type { RequestMeta } from '../auth/auth.service';
import type { LeadDto, WidgetFacilityDto, WidgetLeadInput } from '@storageos/shared';

/**
 * Servicio del widget público embebible. Usa la conexión admin
 * (`PrismaAdminService`) para resolver el tenant por slug sin contexto
 * de auth, pero todas las escrituras hacen tenant scoping explícito.
 */
@Injectable()
export class WidgetService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly leads: LeadsService,
  ) {}

  /**
   * Tenant del widget. No se sirve si está borrado o suspendido, ni si su web
   * aún no está publicada (mismo criterio que la web pública).
   */
  private async resolveTenant(slug: string): Promise<{ id: string }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true, status: true },
    });
    if (
      !tenant ||
      tenant.deletedAt ||
      tenant.status === 'suspended' ||
      !webPublished(await tenantReadiness(this.admin, tenant.id))
    ) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    return tenant;
  }

  /**
   * Locales activos del tenant con los tamaños que tiene cada uno. No expone
   * trasteros concretos, solo el agregado por tipo. El precio es el de la web:
   * el del trastero más barato disponible de ese tamaño en el local (o, si
   * está agotado, el más barato que tenga), con el IVA real de la cuota.
   */
  async listFacilities(slug: string): Promise<WidgetFacilityDto[]> {
    const tenant = await this.resolveTenant(slug);
    const [facilities, unitTypes, available, all] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId: tenant.id, isActive: true, deletedAt: null },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId: tenant.id, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id, status: 'available' },
        _count: { _all: true },
        _min: { basePriceMonthly: true },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id },
        _min: { basePriceMonthly: true },
      }),
    ]);
    const availableBy = new Map(available.map((g) => [`${g.facilityId}:${g.unitTypeId}`, g]));
    const allBy = new Map(all.map((g) => [`${g.facilityId}:${g.unitTypeId}`, g]));
    return facilities.map((f) => ({
      id: f.id,
      name: f.name,
      city: f.city,
      // Solo los tamaños que el local tiene (agotados con 0 disponibles).
      unitTypes: unitTypes
        .filter((ut) => allBy.has(`${f.id}:${ut.id}`))
        .map((ut) => {
          const key = `${f.id}:${ut.id}`;
          const free = availableBy.get(key);
          const min = free?._min.basePriceMonthly ?? allBy.get(key)?._min.basePriceMonthly;
          return {
            id: ut.id,
            name: ut.name,
            description: ut.description,
            defaultPriceMonthly: min != null ? Number(min) : Number(ut.defaultPriceMonthly),
            taxRate: rentTax(ut.propertyKind).taxRate,
            color: ut.color,
            availableUnits: free?._count._all ?? 0,
          };
        }),
    }));
  }

  async submitLead(args: {
    slug: string;
    input: WidgetLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    const tenant = await this.resolveTenant(args.slug);
    return this.leads.createFromWidget({
      tenantId: tenant.id,
      input: args.input,
      meta: args.meta,
    });
  }
}
