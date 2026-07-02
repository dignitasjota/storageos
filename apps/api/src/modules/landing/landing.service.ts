import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type {
  PublicFacilityLandingDto,
  PublicLandingDto,
  PublicLandingFacilityDto,
  PublicSitemapDto,
} from '@storageos/shared';

/**
 * Datos públicos para la landing por tenant (`/s/[slug]`). Sin auth ni RLS:
 * usa `PrismaAdminService` resolviendo el tenant por slug, igual que el
 * widget/booking públicos. Solo expone información de marketing + disponibilidad
 * (nunca datos de clientes ni internos).
 */
@Injectable()
export class LandingService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
  ) {}

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
          publicSlug: true,
          name: true,
          address: true,
          city: true,
          postalCode: true,
          contactPhone: true,
          contactEmail: true,
          openingHours: true,
          images: true,
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
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      facilities: facilities.map((f) => ({
        id: f.id,
        publicSlug: f.publicSlug,
        name: f.name,
        address: f.address,
        city: f.city,
        postalCode: f.postalCode,
        contactPhone: f.contactPhone,
        contactEmail: f.contactEmail,
        openingHours: (f.openingHours as Record<string, unknown>) ?? {},
        imageUrls: (f.images ?? []).map((key) => this.files.buildPublicUrl('public', key)),
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

  /** Landing de un único local por su `publicSlug`. */
  async getFacilityBySlug(
    tenantSlug: string,
    facilitySlug: string,
  ): Promise<PublicFacilityLandingDto> {
    const full = await this.getBySlug(tenantSlug);
    const facility = full.facilities.find(
      (f: PublicLandingFacilityDto) => f.publicSlug === facilitySlug,
    );
    if (!facility) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'No encontrado' });
    }
    return {
      tenantName: full.tenantName,
      tenantSlug: full.tenantSlug,
      brandColor: full.brandColor,
      logoUrl: full.logoUrl,
      facility,
    };
  }

  /**
   * URLs indexables para el sitemap: tenants activos (con suscripción no
   * cancelada) + los slugs de sus locales activos. Nota: expone los slugs
   * públicos de todos los tenants en el dominio compartido (las landings ya
   * son públicas); si se quiere por dominio propio, filtrar aquí.
   */
  async sitemap(): Promise<PublicSitemapDto> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, status: { in: ['trial', 'active'] } },
      select: { slug: true, updatedAt: true },
    });
    if (tenants.length === 0) return { entries: [] };

    const facilities = await this.admin.facility.findMany({
      where: { deletedAt: null, isActive: true, publicSlug: { not: null } },
      select: { publicSlug: true, tenant: { select: { slug: true } } },
    });
    const bySlug = new Map<string, string[]>();
    for (const f of facilities) {
      if (!f.publicSlug) continue;
      const list = bySlug.get(f.tenant.slug) ?? [];
      list.push(f.publicSlug);
      bySlug.set(f.tenant.slug, list);
    }

    return {
      entries: tenants.map((t) => ({
        tenantSlug: t.slug,
        updatedAt: t.updatedAt.toISOString(),
        facilitySlugs: bySlug.get(t.slug) ?? [],
      })),
    };
  }
}
