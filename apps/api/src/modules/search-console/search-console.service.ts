import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  shiftDate,
  summarizeSearchConsole,
  type SearchConsoleSettingsDto,
  type SearchConsoleStatus,
  type SeoPositionsDto,
} from '@storageos/shared';

import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { SearchConsoleClient } from './search-console.client';

/** Días que se descargan al conectar la propiedad. */
const INITIAL_DAYS = 120;
/** Días que se repasan cada día (Search Console corrige los últimos días). */
const DAILY_DAYS = 6;
/** Se guardan unos 16 meses (lo mismo que conserva Google). */
const KEEP_DAYS = 480;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Seguimiento de posiciones con Search Console (extra «SEO local»): conectar
 * la propiedad del tenant, descargar sus búsquedas cada día y resumirlas.
 */
@Injectable()
export class SearchConsoleService {
  private readonly logger = new Logger(SearchConsoleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly client: SearchConsoleClient,
  ) {}

  async settings(tenantId: string): Promise<SearchConsoleSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantSearchConsole.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      available: this.client.available,
      serviceAccountEmail: this.client.serviceAccountEmail,
      siteUrl: row?.siteUrl ?? null,
      status: (row?.status as SearchConsoleStatus | undefined) ?? null,
      lastError: row?.lastError ?? null,
      connectedAt: row?.connectedAt?.toISOString() ?? null,
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    };
  }

  /** Guarda la propiedad, comprueba el acceso y descarga los últimos meses. */
  async connect(tenantId: string, siteUrl: string): Promise<SearchConsoleSettingsDto> {
    if (!this.client.available) {
      throw new ServiceUnavailableException({
        code: 'search_console_not_configured',
        message: 'La conexión con Search Console no está disponible todavía.',
      });
    }
    let access = false;
    let error: string | null = null;
    try {
      access = await this.client.hasAccess(siteUrl);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const lastError = access
      ? null
      : (error ??
        `Nuestra cuenta (${this.client.serviceAccountEmail}) no tiene acceso a ${siteUrl}. Añádela como usuario en Search Console → Configuración → Usuarios y permisos.`);
    await this.prisma.withTenant(
      (tx) =>
        tx.tenantSearchConsole.upsert({
          where: { tenantId },
          create: {
            tenantId,
            siteUrl,
            status: access ? 'connected' : 'error',
            lastError,
            connectedAt: access ? new Date() : null,
          },
          update: {
            siteUrl,
            status: access ? 'connected' : 'error',
            lastError,
            connectedAt: access ? new Date() : null,
          },
        }),
      tenantId,
    );
    if (!access) {
      throw new BadRequestException({ code: 'search_console_no_access', message: lastError });
    }
    await this.sync(tenantId, INITIAL_DAYS);
    return this.settings(tenantId);
  }

  async disconnect(tenantId: string): Promise<SearchConsoleSettingsDto> {
    await this.prisma.withTenant(async (tx) => {
      await tx.searchConsoleRow.deleteMany({ where: { tenantId } });
      await tx.tenantSearchConsole.deleteMany({ where: { tenantId } });
    }, tenantId);
    return this.settings(tenantId);
  }

  /**
   * Descarga los últimos `days` días y sustituye lo guardado de ese tramo.
   * Un fallo queda en `lastError` (no lanza).
   */
  async sync(tenantId: string, days = DAILY_DAYS): Promise<{ rows: number; ok: boolean }> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantSearchConsole.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) return { rows: 0, ok: false };
    const end = shiftDate(today(), -1);
    const start = shiftDate(end, -(days - 1));
    try {
      const rows = await this.client.searchAnalytics(row.siteUrl, start, end);
      await this.prisma.withTenant(
        async (tx) => {
          await tx.searchConsoleRow.deleteMany({
            where: {
              tenantId,
              OR: [
                { date: { gte: new Date(`${start}T00:00:00Z`) } },
                { date: { lt: new Date(`${shiftDate(today(), -KEEP_DAYS)}T00:00:00Z`) } },
              ],
            },
          });
          if (rows.length > 0) {
            await tx.searchConsoleRow.createMany({
              data: rows.map((r) => ({
                tenantId,
                date: new Date(`${r.date}T00:00:00Z`),
                query: r.query.slice(0, 500),
                page: r.page.slice(0, 1000),
                clicks: r.clicks,
                impressions: r.impressions,
                position: Math.round(r.position * 100) / 100,
              })),
              skipDuplicates: true,
            });
          }
          await tx.tenantSearchConsole.update({
            where: { tenantId },
            data: { status: 'connected', lastError: null, lastSyncedAt: new Date() },
          });
        },
        tenantId,
        { timeout: 60_000 },
      );
      return { rows: rows.length, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[search-console] tenant ${tenantId}: ${message}`);
      await this.prisma.withTenant(
        (tx) =>
          tx.tenantSearchConsole.update({
            where: { tenantId },
            data: { status: 'error', lastError: message.slice(0, 500) },
          }),
        tenantId,
      );
      return { rows: 0, ok: false };
    }
  }

  /** Cron diario: todos los tenants conectados que tienen el extra. */
  async syncAllDue(): Promise<{ tenants: number; synced: number }> {
    const rows = await this.admin.tenantSearchConsole.findMany({
      where: { status: { in: ['connected', 'error'] } },
      select: { tenantId: true },
    });
    let synced = 0;
    for (const { tenantId } of rows) {
      if (!(await tenantHasFeature(this.admin, tenantId, 'local_seo'))) continue;
      if ((await this.sync(tenantId)).ok) synced += 1;
    }
    return { tenants: rows.length, synced };
  }

  /** Resumen del periodo (7, 28 o 90 días) frente al anterior. */
  async positions(tenantId: string, days: number): Promise<SeoPositionsDto> {
    const span = [7, 28, 90].includes(days) ? days : 28;
    const since = shiftDate(today(), -(span * 2 + 7));
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.searchConsoleRow.findMany({
          where: { tenantId, date: { gte: new Date(`${since}T00:00:00Z`) } },
          select: {
            date: true,
            query: true,
            page: true,
            clicks: true,
            impressions: true,
            position: true,
          },
        }),
      tenantId,
    );
    return summarizeSearchConsole(
      rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        query: r.query,
        page: r.page,
        clicks: r.clicks,
        impressions: r.impressions,
        position: Number(r.position),
      })),
      span,
    );
  }
}
