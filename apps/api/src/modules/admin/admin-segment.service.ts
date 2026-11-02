import { Injectable } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTenantsService } from './admin-tenants.service';

import type { Prisma } from '@storageos/database';
import type { AnnouncementSegment } from '@storageos/shared';

export interface SegmentTenant {
  id: string;
  name: string;
  billingEmail: string | null;
}

export interface SegmentRecipient {
  tenantId: string;
  tenantName: string;
  email: string;
  /** Usuario propietario (null si es el email de facturación). */
  userId: string | null;
  fullName: string | null;
  optedOut: boolean;
}

/**
 * Resuelve un segmento de tenants (anuncios y encuestas). Nunca incluye a los
 * dados de baja ni a los borrados.
 */
@Injectable()
export class AdminSegmentService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tenants: AdminTenantsService,
  ) {}

  async tenantsFor(segment: AnnouncementSegment): Promise<SegmentTenant[]> {
    const where: Prisma.TenantWhereInput = { deletedAt: null };
    if (segment.tenantIds?.length) {
      where.id = { in: segment.tenantIds };
      where.status = { not: 'cancelled' };
    } else {
      if (segment.audience === 'active') where.status = 'active';
      else if (segment.audience === 'trial') where.status = 'trial';
      else where.status = { in: ['active', 'trial'] };
      if (segment.tag) where.tags = { has: segment.tag };
      if (segment.plans?.length) {
        where.subscription = { plan: { slug: { in: segment.plans } } };
      }
      const and: Prisma.TenantWhereInput[] = [];
      if (segment.addons?.length) {
        and.push({
          subscriptionAddons: {
            some: { suspendedAt: null, addon: { slug: { in: segment.addons } } },
          },
        });
      }
      if (segment.missingAddons?.length) {
        and.push({
          subscriptionAddons: {
            none: { suspendedAt: null, addon: { slug: { in: segment.missingAddons } } },
          },
        });
      }
      if (and.length) where.AND = and;
    }

    let rows = await this.admin.tenant.findMany({
      where,
      select: { id: true, name: true, billingEmail: true },
      orderBy: { name: 'asc' },
    });
    if (segment.tenantIds?.length) return rows;

    if (segment.minFacilities != null || segment.maxFacilities != null) {
      const counts = await this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: rows.map((r) => r.id) }, deletedAt: null },
        _count: { _all: true },
      });
      const byTenant = new Map(counts.map((c) => [c.tenantId, c._count._all]));
      rows = rows.filter((r) => {
        const n = byTenant.get(r.id) ?? 0;
        if (segment.minFacilities != null && n < segment.minFacilities) return false;
        if (segment.maxFacilities != null && n > segment.maxFacilities) return false;
        return true;
      });
    }
    if (segment.inactiveDays != null) {
      const since = new Date(Date.now() - segment.inactiveDays * 86_400_000);
      const logins = await this.admin.user.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: rows.map((r) => r.id) }, isActive: true },
        _max: { lastLoginAt: true },
      });
      const last = new Map(logins.map((l) => [l.tenantId, l._max.lastLoginAt]));
      rows = rows.filter((r) => {
        const at = last.get(r.id);
        return !at || at < since;
      });
    }
    if (segment.health?.length) {
      const wanted = new Set<string>(segment.health);
      const health = await this.tenants.getTenantsHealth();
      const ok = new Set(health.filter((h) => wanted.has(h.level)).map((h) => h.tenantId));
      rows = rows.filter((r) => ok.has(r.id));
    }
    return rows;
  }

  /**
   * Destinatarios: los propietarios activos con el email verificado; sin
   * ninguno, el email de facturación (salvo en los comerciales, que van solo
   * a usuarios para poder darse de baja).
   */
  async recipientsFor(tenants: SegmentTenant[], commercial: boolean): Promise<SegmentRecipient[]> {
    if (tenants.length === 0) return [];
    const owners = await this.admin.user.findMany({
      where: {
        tenantId: { in: tenants.map((t) => t.id) },
        role: 'owner',
        isActive: true,
        emailVerifiedAt: { not: null },
      },
      select: {
        id: true,
        tenantId: true,
        email: true,
        fullName: true,
        platformNewsOptOutAt: true,
      },
    });
    const byTenant = new Map<string, typeof owners>();
    for (const o of owners) {
      const list = byTenant.get(o.tenantId) ?? [];
      list.push(o);
      byTenant.set(o.tenantId, list);
    }
    const out: SegmentRecipient[] = [];
    for (const t of tenants) {
      const seen = new Set<string>();
      for (const o of byTenant.get(t.id) ?? []) {
        const email = o.email.toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);
        out.push({
          tenantId: t.id,
          tenantName: t.name,
          email,
          userId: o.id,
          fullName: o.fullName,
          optedOut: commercial && !!o.platformNewsOptOutAt,
        });
      }
      if (seen.size === 0 && !commercial && t.billingEmail) {
        out.push({
          tenantId: t.id,
          tenantName: t.name,
          email: t.billingEmail.toLowerCase(),
          userId: null,
          fullName: null,
          optedOut: false,
        });
      }
    }
    return out;
  }
}
