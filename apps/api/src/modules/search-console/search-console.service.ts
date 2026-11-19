import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  searchConsoleSiteAllowed,
  shiftDate,
  summarizeSearchConsole,
  type CreateTrackedKeywordInput,
  type SeoDetailDto,
  type SeoGoogleFunnelDto,
  type TrackedKeywordDto,
  type UpdateSeoSettingsInput,
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
/** Al conectar, los totales de cada día de esos 16 meses (para el año pasado). */
const HISTORY_DAYS = KEEP_DAYS;
/** Caída que avisa: un 30 % menos de clics en 7 días con al menos 20 antes. */
const DROP_RATIO = 0.7;
const DROP_MIN_CLICKS = 20;

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
      brandTerms: row?.brandTerms ?? [],
      reportRecipientIds: row?.reportRecipientIds ?? [],
    };
  }

  /** Palabras de la marca y quién recibe el informe. */
  async updateSettings(
    tenantId: string,
    input: UpdateSeoSettingsInput,
  ): Promise<SearchConsoleSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantSearchConsole.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new BadRequestException({
        code: 'search_console_not_connected',
        message: 'Conecta Search Console primero.',
      });
    }
    const data: { brandTerms?: string[]; reportRecipientIds?: string[] } = {};
    if (input.brandTerms) {
      data.brandTerms = [...new Set(input.brandTerms.map((t) => t.trim().toLowerCase()))];
    }
    if (input.reportRecipientIds) {
      // Solo personas activas de este negocio.
      const users = await this.admin.user.findMany({
        where: { tenantId, isActive: true, id: { in: input.reportRecipientIds } },
        select: { id: true },
      });
      if (users.length !== new Set(input.reportRecipientIds).size) {
        throw new BadRequestException({
          code: 'invalid_recipient',
          message: 'Alguna de las personas elegidas no es de tu equipo',
        });
      }
      data.reportRecipientIds = users.map((u) => u.id);
    }
    await this.prisma.withTenant(
      (tx) => tx.tenantSearchConsole.update({ where: { tenantId }, data }),
      tenantId,
    );
    return this.settings(tenantId);
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
        await tx.searchConsoleDevice.deleteMany({ where: { tenantId } });
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
    await this.sync(tenantId, INITIAL_DAYS, HISTORY_DAYS);
    return this.settings(tenantId);
  }

  async disconnect(tenantId: string): Promise<SearchConsoleSettingsDto> {
    await this.prisma.withTenant(async (tx) => {
      await tx.searchConsoleRow.deleteMany({ where: { tenantId } });
      await tx.searchConsoleDay.deleteMany({ where: { tenantId } });
      await tx.searchConsoleDevice.deleteMany({ where: { tenantId } });
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
  async sync(
    tenantId: string,
    days?: number,
    /** Días de totales por día y dispositivo (al conectar, 16 meses). */
    totalsDays?: number,
  ): Promise<{ rows: number; ok: boolean }> {
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
    const totalsSpan = Math.min(KEEP_DAYS, Math.max(span, totalsDays ?? span));
    const totalsStart = shiftDate(end, -(totalsSpan - 1));
    try {
      const [rows, dayTotals, deviceTotals] = await Promise.all([
        this.client.searchAnalytics(row.siteUrl, start, end),
        this.client.searchAnalyticsDays(row.siteUrl, totalsStart, end),
        this.client.searchAnalyticsDevices(row.siteUrl, totalsStart, end),
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
          const totalsWhere = {
            tenantId,
            OR: [
              { date: { gte: new Date(`${totalsStart}T00:00:00Z`) } },
              { date: { lt: new Date(`${shiftDate(today(), -KEEP_DAYS)}T00:00:00Z`) } },
            ],
          };
          await tx.searchConsoleDay.deleteMany({ where: totalsWhere });
          await tx.searchConsoleDevice.deleteMany({ where: totalsWhere });
          if (deviceTotals.length > 0) {
            await tx.searchConsoleDevice.createMany({
              data: deviceTotals.map((d) => ({
                tenantId,
                date: new Date(`${d.date}T00:00:00Z`),
                device: d.device.slice(0, 20),
                clicks: d.clicks,
                impressions: d.impressions,
                position: Math.round(d.position * 100) / 100,
              })),
              skipDuplicates: true,
            });
          }
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
      if (ok) {
        synced += 1;
        await this.checkDrop(tenantId).catch((err: unknown) =>
          this.logger.warn(`[search-console] aviso de caída ${tenantId}: ${String(err)}`),
        );
      }
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
    // Los totales por día llegan hasta el año pasado (misma semana).
    const daysSince = shiftDate(today(), -(364 + span + 7));
    const { rows, dayRows, deviceRows, first, settings } = await this.prisma.withTenant(
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
          where: { tenantId, date: { gte: new Date(`${daysSince}T00:00:00Z`) } },
          select: { date: true, clicks: true, impressions: true, position: true },
        }),
        deviceRows: await tx.searchConsoleDevice.findMany({
          where: { tenantId, date: { gte: new Date(`${since}T00:00:00Z`) } },
          select: { date: true, device: true, clicks: true, impressions: true, position: true },
        }),
        settings: await tx.tenantSearchConsole.findUnique({
          where: { tenantId },
          select: { brandTerms: true },
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
        brandTerms: settings?.brandTerms ?? [],
        devices: deviceRows.map((d) => ({
          date: d.date.toISOString().slice(0, 10),
          device: d.device,
          clicks: d.clicks,
          impressions: d.impressions,
          position: Number(d.position),
        })),
      },
    );
  }

  // ---- Búsquedas que se siguen ----

  async listKeywords(tenantId: string, days: number): Promise<TrackedKeywordDto[]> {
    const span = [7, 28, 90].includes(days) ? days : 28;
    const end = shiftDate(today(), -1);
    const from = shiftDate(end, -(span - 1));
    const prevFrom = shiftDate(from, -span);
    const { keywords, rows } = await this.prisma.withTenant(async (tx) => {
      const keywords = await tx.seoTrackedKeyword.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const rows =
        keywords.length === 0
          ? []
          : await tx.$queryRaw<
              {
                q: string;
                recent: boolean;
                clicks: bigint;
                impressions: bigint;
                weighted: number;
              }[]
            >`
                SELECT lower(query) AS q,
                       date >= ${new Date(`${from}T00:00:00Z`)} AS recent,
                       SUM(clicks)::bigint AS clicks,
                       SUM(impressions)::bigint AS impressions,
                       SUM(position * impressions)::float8 AS weighted
                FROM search_console_rows
                WHERE tenant_id = ${tenantId}::uuid
                  AND date >= ${new Date(`${prevFrom}T00:00:00Z`)}
                  AND lower(query) = ANY(${keywords.map((k) => k.keyword.toLowerCase())})
                GROUP BY 1, 2`;
      return { keywords, rows };
    }, tenantId);
    const pos = (r: (typeof rows)[number] | undefined) =>
      r && Number(r.impressions) > 0
        ? Math.round((r.weighted / Number(r.impressions)) * 10) / 10
        : null;
    return keywords.map((k) => {
      const key = k.keyword.toLowerCase();
      const now = rows.find((r) => r.q === key && r.recent);
      const before = rows.find((r) => r.q === key && !r.recent);
      const position = pos(now);
      return {
        id: k.id,
        keyword: k.keyword,
        targetPosition: k.targetPosition,
        position,
        previousPosition: pos(before),
        clicks: Number(now?.clicks ?? 0),
        impressions: Number(now?.impressions ?? 0),
        reached: position !== null && k.targetPosition !== null && position <= k.targetPosition,
      };
    });
  }

  async addKeyword(tenantId: string, input: CreateTrackedKeywordInput): Promise<void> {
    const count = await this.prisma.withTenant(
      (tx) => tx.seoTrackedKeyword.count({ where: { tenantId } }),
      tenantId,
    );
    if (count >= 50) {
      throw new BadRequestException({
        code: 'too_many_keywords',
        message: 'Puedes seguir hasta 50 búsquedas',
      });
    }
    try {
      await this.prisma.withTenant(
        (tx) =>
          tx.seoTrackedKeyword.create({
            data: {
              tenantId,
              keyword: input.keyword.trim(),
              targetPosition: input.targetPosition ?? null,
            },
          }),
        tenantId,
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          code: 'keyword_exists',
          message: 'Ya sigues esa búsqueda',
        });
      }
      throw err;
    }
  }

  async removeKeyword(tenantId: string, id: string): Promise<void> {
    const res = await this.prisma.withTenant(
      (tx) => tx.seoTrackedKeyword.deleteMany({ where: { tenantId, id } }),
      tenantId,
    );
    if (res.count === 0) {
      throw new NotFoundException({ code: 'keyword_not_found', message: 'No encontrada' });
    }
  }

  /** Una búsqueda o una página día a día, con sus páginas o sus búsquedas. */
  async detail(
    tenantId: string,
    kind: 'query' | 'page',
    key: string,
    days: number,
  ): Promise<SeoDetailDto> {
    const span = [7, 28, 90].includes(days) ? days : 28;
    // El mismo periodo que la lista: hasta el último día descargado.
    const last = await this.prisma.withTenant(
      (tx) =>
        tx.searchConsoleRow.findFirst({
          where: { tenantId },
          orderBy: { date: 'desc' },
          select: { date: true },
        }),
      tenantId,
    );
    const lastDate = last ? last.date.toISOString().slice(0, 10) : shiftDate(today(), -1);
    const from = new Date(`${shiftDate(lastDate, -(span - 1))}T00:00:00Z`);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.searchConsoleRow.findMany({
          where: {
            tenantId,
            date: { gte: from },
            ...(kind === 'query' ? { query: key } : { page: key }),
          },
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
    const agg = (
      map: Map<string, { c: number; i: number; w: number }>,
      k: string,
      r: (typeof rows)[number],
    ) => {
      const a = map.get(k) ?? { c: 0, i: 0, w: 0 };
      a.c += r.clicks;
      a.i += r.impressions;
      a.w += Number(r.position) * r.impressions;
      map.set(k, a);
    };
    const byDay = new Map<string, { c: number; i: number; w: number }>();
    const byRelated = new Map<string, { c: number; i: number; w: number }>();
    for (const r of rows) {
      agg(byDay, r.date.toISOString().slice(0, 10), r);
      agg(byRelated, kind === 'query' ? r.page : r.query, r);
    }
    const pos = (a: { i: number; w: number }) => (a.i > 0 ? Math.round((a.w / a.i) * 10) / 10 : 0);
    return {
      kind,
      key,
      daily: [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, a]) => ({ date, clicks: a.c, impressions: a.i, position: pos(a) })),
      related: [...byRelated.entries()]
        .map(([label, a]) => ({ label, clicks: a.c, impressions: a.i, position: pos(a) }))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
        .slice(0, 50),
    };
  }

  /**
   * De Google a reservas: clics en Google, visitantes que llegan desde Google
   * sin anuncios, contactos y reservas con ese origen, y por qué página entran.
   */
  async googleFunnel(tenantId: string, days: number): Promise<SeoGoogleFunnelDto> {
    const span = [7, 28, 90].includes(days) ? days : 28;
    const to = shiftDate(today(), -1);
    const from = shiftDate(to, -(span - 1));
    const since = new Date(`${from}T00:00:00Z`);
    const until = new Date(`${shiftDate(to, 1)}T00:00:00Z`);
    return this.prisma.withTenant(async (tx) => {
      const clicks = await tx.searchConsoleDay.aggregate({
        where: { tenantId, date: { gte: since, lt: until } },
        _sum: { clicks: true },
      });
      const [visitors] = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(DISTINCT visitor_id)::bigint AS n FROM web_events
          WHERE tenant_id = ${tenantId}::uuid AND kind = 'page_view'
            AND source = 'google' AND COALESCE(medium, 'organic') = 'organic'
            AND created_at >= ${since} AND created_at < ${until}`;
      const pages = await tx.$queryRaw<{ path: string; n: bigint }[]>`
          SELECT path, COUNT(DISTINCT visitor_id)::bigint AS n FROM web_events
          WHERE tenant_id = ${tenantId}::uuid AND kind = 'page_view'
            AND source = 'google' AND COALESCE(medium, 'organic') = 'organic'
            AND created_at >= ${since} AND created_at < ${until}
          GROUP BY path ORDER BY n DESC LIMIT 10`;
      const leads = await tx.lead.findMany({
        where: {
          tenantId,
          deletedAt: null,
          utmSource: 'google',
          OR: [{ utmMedium: 'organic' }, { utmMedium: null }],
          createdAt: { gte: since, lt: until },
        },
        select: { status: true, convertedContractId: true },
      });
      return {
        from,
        to,
        googleClicks: clicks._sum.clicks ?? 0,
        visitors: Number(visitors?.n ?? 0),
        contacts: leads.length,
        bookings: leads.filter((l) => l.status === 'won' || l.convertedContractId).length,
        pages: pages.map((p) => ({ path: p.path, visitors: Number(p.n) })),
      };
    }, tenantId);
  }

  /** Aviso al equipo si los clics de la última semana caen mucho (uno por semana). */
  async checkDrop(tenantId: string): Promise<boolean> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantSearchConsole.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) return false;
    if (row.lastDropAlertAt && row.lastDropAlertAt.getTime() > Date.now() - 7 * 86_400_000) {
      return false;
    }
    const days = await this.prisma.withTenant(
      (tx) =>
        tx.searchConsoleDay.findMany({
          where: { tenantId },
          orderBy: { date: 'desc' },
          take: 14,
          select: { clicks: true },
        }),
      tenantId,
    );
    if (days.length < 14) return false;
    const last = days.slice(0, 7).reduce((s, d) => s + d.clicks, 0);
    const prev = days.slice(7).reduce((s, d) => s + d.clicks, 0);
    if (prev < DROP_MIN_CLICKS || last >= prev * DROP_RATIO) return false;
    const pct = Math.round((1 - last / prev) * 100);
    await this.notifications.create(tenantId, {
      type: 'seo.clicks_drop',
      title: `Los clics desde Google han bajado un ${pct} %`,
      body: `Esta semana ${last} clics frente a ${prev} la anterior. Mira qué búsquedas y páginas han caído.`,
      link: '/seo',
    });
    await this.prisma.withTenant(
      (tx) =>
        tx.tenantSearchConsole.update({
          where: { tenantId },
          data: { lastDropAlertAt: new Date() },
        }),
      tenantId,
    );
    return true;
  }
}
