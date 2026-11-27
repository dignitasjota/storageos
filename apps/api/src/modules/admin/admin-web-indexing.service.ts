import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DEMO_TENANT_TAG,
  decideWebIndexing,
  suspensionDays,
  todayWebIndexing,
  type AdminTenantWebIndexingDto,
  type AdminWebIndexingPreviewDto,
  type WebIndexingMode,
  type WebIndexingPreviewRow,
  type WebIndexingStatus,
} from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

const STATE_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  tags: true,
  webIndexing: true,
  canceledAt: true,
  updatedAt: true,
} as const;

interface StateRow {
  id: string;
  name: string;
  slug: string;
  status: WebIndexingStatus;
  tags: string[];
  webIndexing: string;
  canceledAt: Date | null;
  updatedAt: Date;
}

/**
 * Indexación en Google por tenant (D3). La decisión vive en `decideWebIndexing`
 * (shared); aquí solo se lee el estado y se guarda el modo.
 */
@Injectable()
export class AdminWebIndexingService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {}

  /** Lo mismo que el sitemap: cuenta verificada y algún local activo (sin el atajo de tests). */
  private async publishedMap(tenantIds?: string[]): Promise<Map<string, boolean>> {
    const scope = tenantIds ? { tenantId: { in: tenantIds } } : {};
    const [verified, facilities] = await Promise.all([
      this.admin.user.groupBy({
        by: ['tenantId'],
        where: { ...scope, emailVerifiedAt: { not: null } },
        _count: { _all: true },
      }),
      this.admin.facility.groupBy({
        by: ['tenantId'],
        where: { ...scope, deletedAt: null, isActive: true },
        _count: { _all: true },
      }),
    ]);
    const withVerified = new Set(verified.map((r) => r.tenantId));
    const withFacility = new Set(facilities.map((r) => r.tenantId));
    const out = new Map<string, boolean>();
    for (const id of tenantIds ?? [...withVerified, ...withFacility]) {
      out.set(id, withVerified.has(id) && withFacility.has(id));
    }
    return out;
  }

  private toState(t: StateRow, webPublished: boolean): AdminTenantWebIndexingDto {
    const isDemo = t.tags.includes(DEMO_TENANT_TAG);
    const suspendedDays =
      t.status === 'suspended' ? suspensionDays(t.canceledAt ?? t.updatedAt) : null;
    const mode = t.webIndexing as WebIndexingMode;
    return {
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      isDemo,
      mode,
      webPublished,
      suspendedDays,
      decision: decideWebIndexing({ webPublished, status: t.status, isDemo, suspendedDays, mode }),
    };
  }

  async get(tenantId: string): Promise<AdminTenantWebIndexingDto> {
    const t = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: STATE_SELECT,
    });
    if (!t) throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    const published = (await this.publishedMap([tenantId])).get(tenantId) ?? false;
    return this.toState(t, published);
  }

  async set(
    tenantId: string,
    mode: WebIndexingMode,
    meta: { superAdminId: string; reason?: string },
  ): Promise<AdminTenantWebIndexingDto> {
    const t = await this.admin.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, webIndexing: true },
    });
    if (!t) throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    if (t.webIndexing !== mode) {
      await this.admin.tenant.update({ where: { id: tenantId }, data: { webIndexing: mode } });
      await this.audit.write({
        tenantId,
        userId: null,
        action: 'admin.tenant.web_indexing_changed',
        entityType: 'Tenant',
        entityId: tenantId,
        changes: {
          from: t.webIndexing,
          to: mode,
          superAdminId: meta.superAdminId,
          reason: meta.reason ?? null,
        },
      });
    }
    return this.get(tenantId);
  }

  /**
   * Lista previa de solo lectura: por tenant, lo que hoy ve Google y lo que
   * vería con la regla y el modo que tiene guardado. Una sola pasada, sin
   * consultas por tenant.
   */
  async preview(): Promise<AdminWebIndexingPreviewDto> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null },
      select: STATE_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    const published = await this.publishedMap(tenants.map((t) => t.id));
    const rows: WebIndexingPreviewRow[] = tenants.map((t) => {
      const state = this.toState(t, published.get(t.id) ?? false);
      const today = todayWebIndexing({
        webPublished: state.webPublished,
        status: state.status,
        isDemo: state.isDemo,
      });
      const changes =
        today.indexable !== state.decision.indexable ||
        today.inSitemap !== state.decision.inSitemap;
      return {
        tenantId: state.tenantId,
        slug: state.slug,
        name: state.name,
        status: state.status,
        isDemo: state.isDemo,
        mode: state.mode,
        webPublished: state.webPublished,
        today,
        withRule: state.decision,
        changes,
      };
    });
    return {
      checkedAt: new Date().toISOString(),
      changedCount: rows.filter((r) => r.changes).length,
      rows,
    };
  }
}
