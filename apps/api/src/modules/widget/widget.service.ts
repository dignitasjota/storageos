import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { LeadsService } from '../leads/leads.service';

import type { RequestMeta } from '../auth/auth.service';
import type { LeadDto, WidgetFacilityDto, WidgetLeadInput } from '@storageos/shared';

/**
 * Servicio del widget publico embebible. Usa la conexion admin
 * (`PrismaAdminService`) para resolver el tenant por slug sin contexto
 * de auth, pero todas las escrituras hacen tenant scoping explicito.
 */
@Injectable()
export class WidgetService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly leads: LeadsService,
  ) {}

  /**
   * Devuelve facilities activas del tenant con unit types disponibles.
   * No expone identidades de unit individuales — solo agregado por tipo.
   */
  async listFacilities(slug: string): Promise<WidgetFacilityDto[]> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const facilities = await this.admin.facility.findMany({
      where: { tenantId: tenant.id, isActive: true, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    const unitTypes = await this.admin.unitType.findMany({
      where: { tenantId: tenant.id, isActive: true },
      orderBy: { name: 'asc' },
    });
    const availability = await this.admin.unit.groupBy({
      by: ['facilityId', 'unitTypeId', 'status'],
      where: { tenantId: tenant.id },
      _count: { _all: true },
    });
    return facilities.map((f) => ({
      id: f.id,
      name: f.name,
      city: f.city,
      unitTypes: unitTypes.map((ut) => {
        const available = availability.find(
          (a) => a.facilityId === f.id && a.unitTypeId === ut.id && a.status === 'available',
        );
        return {
          id: ut.id,
          name: ut.name,
          description: ut.description,
          defaultPriceMonthly: Number(ut.defaultPriceMonthly),
          color: ut.color,
          availableUnits: available?._count._all ?? 0,
        };
      }),
    }));
  }

  async submitLead(args: {
    slug: string;
    input: WidgetLeadInput;
    meta: RequestMeta;
  }): Promise<LeadDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug: args.slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    return this.leads.createFromWidget({
      tenantId: tenant.id,
      input: args.input,
      meta: args.meta,
    });
  }
}
