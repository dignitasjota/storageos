import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { PublicLandingDto } from '@storageos/shared';

/**
 * Datos públicos para la landing por tenant (`/s/[slug]`). Sin auth ni RLS:
 * usa `PrismaAdminService` resolviendo el tenant por slug, igual que el
 * widget/booking públicos. Solo expone información de marketing + disponibilidad
 * (nunca datos de clientes ni internos).
 */
@Injectable()
export class LandingService {
  constructor(private readonly admin: PrismaAdminService) {}

  async getBySlug(slug: string): Promise<PublicLandingDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }

    const [facilities, unitTypes, grouped] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId: tenant.id, deletedAt: null, isActive: true },
        select: {
          id: true,
          name: true,
          address: true,
          city: true,
          postalCode: true,
          contactPhone: true,
          contactEmail: true,
          openingHours: true,
        },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, defaultPriceMonthly: true },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id, status: 'available' },
        _count: { _all: true },
      }),
    ]);

    const availByFacilityType = new Map<string, number>();
    for (const g of grouped) {
      availByFacilityType.set(`${g.facilityId}:${g.unitTypeId}`, g._count._all);
    }

    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      facilities: facilities.map((f) => ({
        id: f.id,
        name: f.name,
        address: f.address,
        city: f.city,
        postalCode: f.postalCode,
        contactPhone: f.contactPhone,
        contactEmail: f.contactEmail,
        openingHours: (f.openingHours as Record<string, unknown>) ?? {},
        unitTypes: unitTypes
          .map((t) => ({
            id: t.id,
            name: t.name,
            available: availByFacilityType.get(`${f.id}:${t.id}`) ?? 0,
            priceMonthly: Number(t.defaultPriceMonthly),
          }))
          .filter((t) => t.available > 0),
      })),
    };
  }
}
