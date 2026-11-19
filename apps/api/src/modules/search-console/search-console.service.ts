import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  searchConsoleSiteAllowed,
  shiftDate,
  summarizeSearchConsole,
  type SearchConsoleSettingsDto,
  type SearchConsoleStatus,
  type SeoPositionsDto,
} from '@storageos/shared';

import {
  GoogleApiError,
  googleUnavailable,
  isGoogleTransient,
} from '../../common/google/google-service-account';
import { noteConnectionResult } from '../../common/marketing/connection-alert';
import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import { SearchConsoleClient } from './search-console.client';

import type { Env } from '../../config/env.schema';

/**
 * Días que se descargan al conectar la propiedad: lo justo para comparar los
 * últimos 90 días con los 90 anteriores (Google va 2-3 días por detrás).
 */
const INITIAL_DAYS = 190;
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
    private readonly config: ConfigService<Env, true>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * ¿Es el sitio de la web del negocio? Su dominio propio verificado o su
   * dirección en la plataforma: la cuenta de servicio es la misma para todos
   * y, sin esto, un negocio podría ver las búsquedas de otro.
   */
  private async siteAllowed(tenantId: string, siteUrl: string): Promise<boolean> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    if (!tenant) return false;
    return searchConsoleSiteAllowed(siteUrl, {
      slug: tenant.slug,
      customDomain: tenant.customDomainVerifiedAt ? tenant.customDomain : null,
      platformUrl: this.config.get('WEB_BASE_URL', { infer: true }),
    });
  }

  private notYours(siteUrl: string): string {
    return `${siteUrl} no es tu web en TrasterOS. Conecta tu dominio propio (sc-domain:tudominio.es) o tu dirección en la plataforma (${this.config
      .get('WEB_BASE_URL', { infer: true })
      .replace(/\/$/, '')}/s/<tu identificador>/).`;
  }

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
      monthlyReport: row?.monthlyReport ?? true,
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
    if (!(await this.siteAllowed(tenantId, siteUrl))) {
      throw new BadRequestException({
        code: 'search_console_site_not_yours',
        message: this.notYours(siteUrl),
      });
    }
    // Un sitio solo puede estar conectado en un negocio.
    const taken = await this.admin.tenantSearchConsole.findFirst({
      where: { siteUrl: { equals: siteUrl, mode: 'insensitive' }, tenantId: { not: tenantId } },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: 'search_console_site_taken',
        message: 'Ese sitio ya está conectado en otra cuenta de TrasterOS.',
      });
    }
    let access = false;
    let error: string | null = null;
    try {
      access = await this.client.hasAccess(siteUrl);
    } catch (err) {
      // Google no responde ahora: no es que falte acceso.
      if (isGoogleTransient(err)) throw googleUnavailable(err);
      error = err instanceof Error ? err.message : String(err);
    }
    const lastError = access
      ? null
      : (error ??
        `Nuestra cuenta (${this.client.serviceAccountEmail}) no tiene acceso a ${siteUrl}. Añádela como usuario en Search Console → Configuración → Usuarios y permisos.`);
    const current = await this.prisma.withTenant(
      (tx) => tx.tenantSearchConsole.findUnique({ where: { tenantId } }),
      tenantId,
    );
    // Un sitio sin acceso no sustituye a otro que ya funciona.
    if (!access && current && current.status === 'connected' && current.siteUrl !== siteUrl) {
      throw new BadRequestException({ code: 'search_console_no_access', message: lastError });
    }
    await this.prisma.withTenant(async (tx) => {
      // Otro sitio: lo descargado del anterior ya no vale.
      if (current && current.siteUrl !== siteUrl) {
        await tx.searchConsoleRow.deleteMany({ where: { tenantId } });
        await tx.searchConsoleDay.deleteMany({ where: { tenantId } });
      }
      const data = {
        siteUrl,
        status: access ? 'connected' : 'error',
        lastError,
        connectedAt: access ? new Date() : null,
      };
      await tx.tenantSearchConsole.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
      });
    }, tenantId);
    if (!access) {
      throw new BadRequestException({ code: 'search_console_no_access', message: lastError });
    }
    await this.sync(tenantId, INITIAL_DAYS);
    return this.settings(tenantId);
  }

  async disconnect(tenantId: string): Promise<SearchConsoleSettingsDto> {
    await this.prisma.withTenant(async (tx) => {
      await tx.searchConsoleRow.deleteMany({ where: { tenantId } });
      await tx.searchConsoleDay.deleteMany({ where: { tenantId } });
      await tx.tenantSearchConsole.deleteMany({ where: { tenantId } });
    }, tenantId);
    return this.settings(tenantId);
  }

  /**
   * Descarga los últimos días y sustituye lo guardado de ese tramo. Sin `days`,
   * desde la última descarga buena (más los 6 que Google corrige), para no
   * dejar huecos si la descarga falló varios días o el extra estuvo apagado.
   * Un fallo queda en `lastError` (no lanza).
   */
  async sync(tenantId: string, days?: number): Promise<{ rows: number; ok: boolean }> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantSearchConsole.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) return { rows: 0, ok: false };
    // Conectado antes de comprobarlo (o el dominio ya no es suyo): no se descarga.
    if (!(await this.siteAllowed(tenantId, row.siteUrl))) {
      await this.prisma.withTenant(
        (tx) =>
          tx.tenantSearchConsole.update({
            where: { tenantId },
            data: { status: 'error', lastError: this.notYours(row.siteUrl) },
          }),
        tenantId,
      );
      return { rows: 0, ok: false };
    }
    const sinceLast = row.lastSyncedAt
      ? Math.ceil((Date.now() - row.lastSyncedAt.getTime()) / 86_400_000) + DAILY_DAYS
      : INITIAL_DAYS;
    const span = Math.min(KEEP_DAYS, Math.max(DAILY_DAYS, days ?? sinceLast));
    const end = shiftDate(today(), -1);
    const start = shiftDate(end, -(span - 1));
    try {
      const [rows, dayTotals] = await Promise.all([
        this.client.searchAnalytics(row.siteUrl, start, end),
        this.client.searchAnalyticsDays(row.siteUrl, start, end),
      ]);
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
          await tx.searchConsoleDay.deleteMany({
            where: {
              tenantId,
              OR: [
                { date: { gte: new Date(`${start}T00:00:00Z`) } },
                { date: { lt: new Date(`${shiftDate(today(), -KEEP_DAYS)}T00:00:00Z`) } },
              ],
            },
          });
          if (dayTotals.length > 0) {
            await tx.searchConsoleDay.createMany({
              data: dayTotals.map((d) => ({
                tenantId,
                date: new Date(`${d.date}T00:00:00Z`),
                clicks: d.clicks,
                impressions: d.impressions,
                position: Math.round(d.position * 100) / 100,
              })),
              skipDuplicates: true,
            });
          }
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
      // Solo es «sin acceso» si Google dice que no tenemos permiso o que la
      // propiedad no existe; un corte o un fallo suyo deja los datos a la
      // vista con un aviso y se reintenta en la siguiente descarga.
      const noAccess =
        err instanceof GoogleApiError &&
        [401, 403, 404].includes(err.status) &&
        !isGoogleTransient(err);
      const lastError = noAccess
        ? message.slice(0, 500)
        : `No se pudieron descargar los datos nuevos (${message.slice(0, 300)}). Se reintentará en la siguiente descarga.`;
      await this.prisma.withTenant(
        (tx) =>
          tx.tenantSearchConsole.update({
            where: { tenantId },
            data: noAccess ? { status: 'error', lastError } : { lastError },
          }),
        tenantId,
      );
      return { rows: 0, ok: false };
    }
  }

  /** Cron diario: todos los tenants conectados que tienen el extra. */
  async syncAllDue(): Promise<{ tenants: number; synced: number }> {
    const rows = await this.admin.tenantSearchConsole.findMany({
      // Sin los negocios dados de baja o anonimizados.
      where: {
        status: { in: ['connected', 'error'] },
        tenant: { deletedAt: null, status: { notIn: ['cancelled', 'suspended'] } },
      },
      select: { tenantId: true },
    });
    let synced = 0;
    for (const { tenantId } of rows) {
      if (!(await tenantHasFeature(this.admin, tenantId, 'local_seo'))) continue;
      const { ok } = await this.sync(tenantId);
      if (ok) synced += 1;
      const error = ok
        ? null
        : ((
            await this.admin.tenantSearchConsole.findUnique({
              where: { tenantId },
              select: { lastError: true },
            })
          )?.lastError ?? null);
      await noteConnectionResult(
        this.admin,
        this.notifications,
        tenantId,
        'search_console',
        ok,
        error,
      );
    }
    return { tenants: rows.length, synced };
  }

  /** Resumen del periodo (7, 28 o 90 días) frente al anterior. */
  async positions(tenantId: string, days: number): Promise<SeoPositionsDto> {
    const span = [7, 28, 90].includes(days) ? days : 28;
    const since = shiftDate(today(), -(span * 2 + 7));
    const { rows, dayRows, first } = await this.prisma.withTenant(
      async (tx) => ({
        rows: await tx.searchConsoleRow.findMany({
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
        dayRows: await tx.searchConsoleDay.findMany({
          where: { tenantId, date: { gte: new Date(`${since}T00:00:00Z`) } },
          select: { date: true, clicks: true, impressions: true, position: true },
        }),
        // Primer día descargado (de los totales o, si no los hay, de las filas).
        first:
          (await tx.searchConsoleDay.findFirst({
            where: { tenantId },
            orderBy: { date: 'asc' },
            select: { date: true },
          })) ??
          (await tx.searchConsoleRow.findFirst({
            where: { tenantId },
            orderBy: { date: 'asc' },
            select: { date: true },
          })),
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
      {
        days: dayRows.map((d) => ({
          date: d.date.toISOString().slice(0, 10),
          clicks: d.clicks,
          impressions: d.impressions,
          position: Number(d.position),
        })),
        firstDate: first ? first.date.toISOString().slice(0, 10) : null,
      },
    );
  }
}
