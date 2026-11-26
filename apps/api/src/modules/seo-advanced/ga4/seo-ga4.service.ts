import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_GA4_DAILY_DAYS,
  SEO_GA4_INITIAL_DAYS,
  SEO_PRIMARY_CONVERSION_TYPES,
  crossSeoPagePerformance,
  normalizeSeoKeyword,
  normalizeSeoGa4Rows,
  seoGa4Metrics,
  seoLandingKey,
  seoPageLandingKey,
  seoPanelRange,
  shiftDate,
  type ConnectSeoGa4Input,
  type SeoGa4PageDetailDto,
  type SeoGa4PagesDto,
  type SeoGa4SettingsDto,
  type SeoGa4Source,
  type SeoGa4Status,
  type SeoGa4Sums,
  type SeoPageEngagementStat,
  type SeoPagePerformanceSort,
  type SeoPanelPeriod,
  type SeoReportGa4Dto,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import {
  googleUnavailable,
  isGoogleTransient,
} from '../../../common/google/google-service-account';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { ga4OwnershipProblem } from '../../marketing/ga4/ga4-ownership';
import { Ga4Client } from '../../marketing/ga4/ga4.client';
import { JOB_SEO_GA4, QUEUE_SEO } from '../../queues/queue-names';
import { SeoOpportunityScheduler } from '../opportunities/seo-opportunity-scheduler';
import { seoProjectEligible } from '../reports/seo-eligible';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';

const today = () => new Date().toISOString().slice(0, 10);
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** La carga inicial se pide por tramos de un mes (la Data API corta en 50.000 filas). */
const CHUNK_DAYS = 31;
/** Se guarda lo que da la carga inicial y unos días de margen. */
const KEEP_DAYS = SEO_GA4_INITIAL_DAYS + 7;

type ProjectRow = Awaited<ReturnType<SeoProjectsService['resolveProject']>>;

/**
 * Google Analytics 4 del tráfico orgánico de Google por página de entrada
 * (PR 12). Una propiedad por proyecto: la del proyecto (plataforma o tenant)
 * o, en un tenant, la que ya conectó en Marketing (Web Premium), sin pedirla
 * otra vez. El cliente y la cuenta de servicio son los de Marketing; lo que se
 * descarga es otro corte (solo orgánico de Google, por página de entrada), así
 * que va en su tabla (`seo_ga4_landing_daily`).
 */
@Injectable()
export class SeoGa4Service {
  private readonly logger = new Logger(SeoGa4Service.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly client: Ga4Client,
    private readonly opportunities: SeoOpportunityScheduler,
    @InjectQueue(QUEUE_SEO) private readonly queue: Queue,
  ) {}

  // ------------------------------------------------------------- ajustes

  async settings(owner: SeoOwner | undefined, projectId: string): Promise<SeoGa4SettingsDto> {
    const p = await this.projects.resolveProject(owner, projectId);
    const [bounds, marketing] = await Promise.all([
      this.admin.seoGa4LandingDaily.aggregate({
        where: { projectId },
        _min: { date: true },
        _max: { date: true },
      }),
      p.tenantId
        ? this.admin.tenantGa4.findUnique({
            where: { tenantId: p.tenantId },
            select: { propertyId: true, status: true, verifiedAt: true },
          })
        : Promise.resolve(null),
    ]);
    return {
      available: this.client.available,
      serviceAccountEmail: this.client.serviceAccountEmail,
      propertyId: p.ga4PropertyId,
      source: (p.ga4Source as SeoGa4Source | null) ?? null,
      status: (p.ga4Status as SeoGa4Status | null) ?? null,
      lastError: p.ga4LastError,
      connectedAt: p.ga4ConnectedAt?.toISOString() ?? null,
      lastSyncedAt: p.ga4SyncedAt?.toISOString() ?? null,
      initialDone: !!p.ga4InitialDoneAt,
      dataFrom: dateOnly(bounds._min.date),
      dataUntil: dateOnly(bounds._max.date),
      marketing: p.tenantId
        ? {
            connected: !!marketing && marketing.status !== 'pending' && !!marketing.verifiedAt,
            propertyId: marketing?.propertyId ?? null,
          }
        : null,
    };
  }

  /**
   * Conecta la propiedad. En un tenant, o la de Marketing (ya comprobada) o
   * una propia que mida su web (la misma comprobación que Marketing: con una
   * sola cuenta de servicio, sin ella un negocio podría leer los datos de
   * otro). Una propiedad no la pueden usar dos dueños distintos.
   */
  async connect(
    owner: SeoOwner,
    projectId: string,
    input: ConnectSeoGa4Input,
  ): Promise<SeoGa4SettingsDto> {
    const p = await this.projects.resolveProject(owner, projectId);
    if (!this.client.available) {
      throw new ServiceUnavailableException({
        code: 'ga4_not_configured',
        message: 'La conexión con Google Analytics no está disponible todavía.',
      });
    }
    let propertyId: string;
    let source: SeoGa4Source;
    if (input.source === 'marketing') {
      if (!p.tenantId) {
        throw new BadRequestException({
          code: 'seo_ga4_marketing_unavailable',
          message: 'Esta opción es solo para el proyecto de un negocio.',
        });
      }
      const mk = await this.admin.tenantGa4.findUnique({ where: { tenantId: p.tenantId } });
      if (!mk || mk.status === 'pending' || !mk.verifiedAt) {
        throw new BadRequestException({
          code: 'seo_ga4_marketing_missing',
          message:
            'No hay Google Analytics conectado en Marketing → Visitas de la web. Conéctalo allí o pon aquí el número de la propiedad.',
        });
      }
      propertyId = mk.propertyId;
      source = 'marketing';
    } else {
      propertyId = input.propertyId;
      source = 'own';
      await this.assertPropertyFree(p, propertyId);
      let denied: string | null;
      try {
        denied = await this.client.checkAccess(propertyId);
      } catch (err) {
        if (isGoogleTransient(err)) throw googleUnavailable(err);
        throw err;
      }
      if (denied) {
        throw new BadRequestException({
          code: 'seo_ga4_no_access',
          message: `Nuestra cuenta (${this.client.serviceAccountEmail}) no puede leer la propiedad ${propertyId}. Añádela como «Lector» en Google Analytics → Administrar → Gestión del acceso a la propiedad. (${denied})`,
        });
      }
      if (p.tenantId) {
        // La de Marketing ya se comprobó: no hace falta repetirlo.
        const mk = await this.admin.tenantGa4.findUnique({ where: { tenantId: p.tenantId } });
        const already = mk?.propertyId === propertyId && !!mk.verifiedAt;
        if (!already) {
          const problem = await ga4OwnershipProblem(
            this.admin,
            this.client,
            p.tenantId,
            propertyId,
          );
          if (problem) throw new BadRequestException(problem);
        }
      }
    }
    const changed = p.ga4PropertyId !== propertyId;
    await this.admin.$transaction(async (tx) => {
      if (changed) await tx.seoGa4LandingDaily.deleteMany({ where: { projectId } });
      await tx.seoProject.update({
        where: { id: projectId },
        data: {
          ga4PropertyId: propertyId,
          ga4Source: source,
          ga4Status: 'pending',
          ga4LastError: null,
          ga4ConnectedAt: new Date(),
          ...(changed ? { ga4SyncedAt: null, ga4InitialDoneAt: null } : {}),
        },
      });
    });
    await this.enqueue(projectId);
    return this.settings(owner, projectId);
  }

  /** Una propiedad no se comparte entre dueños (otro negocio o la plataforma). */
  private async assertPropertyFree(p: ProjectRow, propertyId: string): Promise<void> {
    const [tenantUse, projectUse] = await Promise.all([
      this.admin.tenantGa4.findFirst({
        where: { propertyId, ...(p.tenantId ? { tenantId: { not: p.tenantId } } : {}) },
        select: { id: true },
      }),
      this.admin.seoProject.findFirst({
        where: {
          ga4PropertyId: propertyId,
          id: { not: p.id },
          ...(p.tenantId
            ? { OR: [{ tenantId: null }, { tenantId: { not: p.tenantId } }] }
            : { tenantId: { not: null } }),
        },
        select: { id: true },
      }),
    ]);
    if (tenantUse || projectUse) {
      throw new ConflictException({
        code: 'seo_ga4_property_taken',
        message: 'Esa propiedad de Google Analytics ya está conectada en otra cuenta de TrasterOS.',
      });
    }
  }

  async disconnect(owner: SeoOwner, projectId: string): Promise<SeoGa4SettingsDto> {
    await this.projects.resolveProject(owner, projectId);
    await this.admin.$transaction([
      this.admin.seoGa4LandingDaily.deleteMany({ where: { projectId } }),
      this.admin.seoProject.update({
        where: { id: projectId },
        data: {
          ga4PropertyId: null,
          ga4Source: null,
          ga4Status: null,
          ga4LastError: null,
          ga4ConnectedAt: null,
          ga4SyncedAt: null,
          ga4InitialDoneAt: null,
        },
      }),
    ]);
    return this.settings(owner, projectId);
  }

  /** «Sincronizar ahora» (la misma cola que la descarga diaria). */
  async syncNow(owner: SeoOwner, projectId: string): Promise<SeoGa4SettingsDto> {
    const p = await this.projects.resolveProject(owner, projectId);
    if (!p.ga4PropertyId) {
      throw new BadRequestException({
        code: 'seo_ga4_not_connected',
        message: 'Conecta primero Google Analytics.',
      });
    }
    await this.enqueue(projectId);
    return this.settings(owner, projectId);
  }

  async enqueue(projectId: string): Promise<void> {
    await this.queue.add(
      JOB_SEO_GA4,
      { projectId },
      { jobId: `seo-ga4-${projectId}`, removeOnComplete: true, removeOnFail: true, attempts: 1 },
    );
  }

  // ------------------------------------------------------------- descarga

  /**
   * Descarga el tráfico orgánico de Google por página de entrada. La primera
   * vez, 16 meses (por tramos de un mes); después, los últimos días (y, si
   * fallaron descargas, desde la última buena). Cada tramo sustituye lo
   * guardado en sus fechas: repetir no duplica. Un fallo queda en el proyecto.
   */
  async sync(projectId: string): Promise<{ ok: boolean; rows: number }> {
    const p = await this.admin.seoProject.findUnique({ where: { id: projectId } });
    if (!p?.ga4PropertyId) return { ok: false, rows: 0 };
    if (!(await seoProjectEligible(this.admin, p.tenantId))) return { ok: false, rows: 0 };
    const fail = async (message: string) => {
      await this.admin.seoProject.update({
        where: { id: projectId },
        data: { ga4Status: 'error', ga4LastError: message.slice(0, 500) },
      });
      return { ok: false, rows: 0 };
    };
    if (p.ga4Source === 'marketing') {
      const mk = p.tenantId
        ? await this.admin.tenantGa4.findUnique({ where: { tenantId: p.tenantId } })
        : null;
      if (!mk || mk.propertyId !== p.ga4PropertyId || !mk.verifiedAt) {
        return fail(
          'La conexión de Google Analytics de Marketing ya no está o es otra propiedad: vuelve a conectarla aquí.',
        );
      }
    }
    const end = shiftDate(today(), -1);
    let days: number;
    if (!p.ga4InitialDoneAt) days = SEO_GA4_INITIAL_DAYS;
    else {
      const since = p.ga4SyncedAt
        ? Math.ceil((Date.now() - p.ga4SyncedAt.getTime()) / 86_400_000) + SEO_GA4_DAILY_DAYS
        : SEO_GA4_INITIAL_DAYS;
      days = Math.max(SEO_GA4_DAILY_DAYS, Math.min(since, SEO_GA4_INITIAL_DAYS));
    }
    const start = shiftDate(end, -(days - 1));
    let rows = 0;
    try {
      for (let from = start; from <= end; from = shiftDate(from, CHUNK_DAYS)) {
        const to = [shiftDate(from, CHUNK_DAYS - 1), end].sort()[0]!;
        const raw = await this.client.organicLandingRows(p.ga4PropertyId, from, to);
        const normalized = normalizeSeoGa4Rows(raw);
        rows += normalized.length;
        await this.admin.$transaction(
          async (tx) => {
            await tx.seoGa4LandingDaily.deleteMany({
              where: { projectId, date: { gte: asDate(from), lte: asDate(to) } },
            });
            if (normalized.length > 0) {
              await tx.seoGa4LandingDaily.createMany({
                data: normalized.map((r) => ({
                  tenantId: p.tenantId,
                  projectId,
                  date: asDate(r.date),
                  host: r.host,
                  landingPath: r.landingPath,
                  sessions: r.sessions,
                  users: r.users,
                  engagedSessions: r.engagedSessions,
                  durationSeconds: r.durationSeconds,
                  pageViews: r.pageViews,
                  keyEvents: r.keyEvents,
                })),
                skipDuplicates: true,
              });
            }
          },
          { timeout: 60_000 },
        );
      }
      await this.admin.seoGa4LandingDaily.deleteMany({
        where: { projectId, date: { lt: asDate(shiftDate(today(), -KEEP_DAYS)) } },
      });
      await this.admin.seoProject.update({
        where: { id: projectId },
        data: {
          ga4Status: 'connected',
          ga4LastError: null,
          ga4SyncedAt: new Date(),
          ga4InitialDoneAt: p.ga4InitialDoneAt ?? new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[seo-ga4] proyecto ${projectId}: ${message}`);
      return fail(message);
    }
    // El factor «Mucho tráfico y poca interacción» de las oportunidades sale de aquí.
    await this.opportunities.schedule(projectId);
    return { ok: true, rows };
  }

  /** Cron diario: los proyectos con GA4 conectado (de la plataforma o con SEO Avanzado). */
  async syncAllDue(): Promise<{ projects: number; synced: number }> {
    const list = await this.admin.seoProject.findMany({
      where: { status: 'active', ga4PropertyId: { not: null } },
      select: { id: true },
    });
    let synced = 0;
    for (const { id } of list) {
      const { ok } = await this.sync(id);
      if (ok) synced += 1;
    }
    return { projects: list.length, synced };
  }

  // -------------------------------------------------------------- lectura

  private async lastDates(p: ProjectRow, domainIds: string[]) {
    const [gsc, ga4] = await Promise.all([
      domainIds.length
        ? this.admin.seoGscMetric.aggregate({
            where: { domainId: { in: domainIds }, grain: 'site' },
            _max: { date: true },
          })
        : Promise.resolve(null),
      this.admin.seoGa4LandingDaily.aggregate({
        where: { projectId: p.id },
        _max: { date: true },
      }),
    ]);
    return { gsc: dateOnly(gsc?._max.date), ga4: dateOnly(ga4._max.date) };
  }

  private hostsOf(p: ProjectRow, domainId: string | null): string[] | null {
    if (!domainId) return null;
    const d = p.domains.find((x) => x.id === domainId);
    if (!d) {
      throw new BadRequestException({
        code: 'seo_domain_not_found',
        message: 'Ese dominio no es de este proyecto.',
      });
    }
    // GA4 puede no dar el host: lo que viene sin host entra con cualquier dominio.
    return [d.domain, ''];
  }

  private ga4Where(projectId: string, from: string, to: string, hosts: string[] | null) {
    return Prisma.sql`project_id = ${projectId}::uuid
      AND date BETWEEN ${from}::date AND ${to}::date
      ${hosts ? Prisma.sql`AND host = ANY(${hosts}::text[])` : Prisma.empty}`;
  }

  private async ga4Sums(
    projectId: string,
    from: string,
    to: string,
    hosts: string[] | null,
  ): Promise<SeoGa4Sums | null> {
    const [r] = await this.admin.$queryRaw<
      {
        n: bigint;
        s: number;
        u: number;
        e: number;
        d: number;
        v: number;
        k: number;
      }[]
    >(Prisma.sql`
      SELECT COUNT(*) AS n, COALESCE(SUM(sessions), 0)::float8 AS s, COALESCE(SUM(users), 0)::float8 AS u,
             COALESCE(SUM(engaged_sessions), 0)::float8 AS e, COALESCE(SUM(duration_seconds), 0)::float8 AS d,
             COALESCE(SUM(page_views), 0)::float8 AS v, COALESCE(SUM(key_events), 0)::float8 AS k
      FROM seo_ga4_landing_daily WHERE ${this.ga4Where(projectId, from, to, hosts)}`);
    if (!r || Number(r.n) === 0) return null;
    return {
      sessions: Number(r.s),
      users: Number(r.u),
      engagedSessions: Number(r.e),
      durationSeconds: Number(r.d),
      pageViews: Number(r.v),
      keyEvents: Number(r.k),
    };
  }

  /**
   * Rendimiento por página de entrada: Search Console (clics, impresiones y
   * posición), GA4 (sesiones, interacción, duración y eventos clave) y las
   * conversiones propias de Google (PR 8). El periodo acaba en el último día
   * que tienen las dos fuentes, para comparar lo mismo.
   */
  async pages(
    owner: SeoOwner | undefined,
    projectId: string,
    q: {
      period: SeoPanelPeriod;
      from?: string | undefined;
      to?: string | undefined;
      domainId?: string | null;
      sort?: SeoPagePerformanceSort;
    },
  ): Promise<SeoGa4PagesDto> {
    const p = await this.projects.resolveProject(owner, projectId);
    const hosts = this.hostsOf(p, q.domainId ?? null);
    const domainIds = q.domainId ? [q.domainId] : p.domains.map((d) => d.id);
    const last = await this.lastDates(p, domainIds);
    const lastDate =
      [last.gsc, last.ga4].filter((d): d is string => !!d).sort()[0] ?? shiftDate(today(), -1);
    const range = seoPanelRange({
      period: q.period,
      lastDate,
      from: q.from ?? null,
      to: q.to ?? null,
    });
    if (!range) {
      throw new BadRequestException({
        code: 'seo_invalid_range',
        message: 'Elige las dos fechas del periodo.',
      });
    }
    const { from, to } = range;
    const [gscRows, ga4Rows, conv, ga4Total] = await Promise.all([
      domainIds.length
        ? this.admin.$queryRaw<{ page: string; c: number; i: number; w: number }[]>(Prisma.sql`
            SELECT page, SUM(clicks)::float8 AS c, SUM(impressions)::float8 AS i,
                   SUM(position * impressions)::float8 AS w
            FROM seo_gsc_metrics
            WHERE domain_id = ANY(${domainIds}::uuid[]) AND grain = 'page'
              AND date BETWEEN ${from}::date AND ${to}::date
            GROUP BY page`)
        : Promise.resolve([]),
      this.admin.$queryRaw<
        { landing: string; s: number; u: number; e: number; d: number; v: number; k: number }[]
      >(Prisma.sql`
        SELECT landing_path AS landing, SUM(sessions)::float8 AS s, SUM(users)::float8 AS u,
               SUM(engaged_sessions)::float8 AS e, SUM(duration_seconds)::float8 AS d,
               SUM(page_views)::float8 AS v, SUM(key_events)::float8 AS k
        FROM seo_ga4_landing_daily WHERE ${this.ga4Where(projectId, from, to, hosts)}
        GROUP BY landing_path`),
      this.admin.$queryRaw<{ landing: string; n: number }[]>(Prisma.sql`
        SELECT landing_path AS landing, SUM(count)::int AS n FROM seo_conversions_daily
        WHERE project_id = ${projectId}::uuid
          AND type = ANY(${SEO_PRIMARY_CONVERSION_TYPES}::text[])
          AND date BETWEEN ${from}::date AND ${to}::date
        GROUP BY landing_path`),
      this.ga4Sums(projectId, from, to, hosts),
    ]);
    const items = crossSeoPagePerformance({
      gsc: gscRows.map((r) => ({
        landing: seoPageLandingKey(r.page),
        clicks: Number(r.c),
        impressions: Number(r.i),
        weightedPosition: Number(r.w),
      })),
      ga4: ga4Rows.map((r) => ({
        landing: r.landing,
        sessions: Number(r.s),
        users: Number(r.u),
        engagedSessions: Number(r.e),
        durationSeconds: Number(r.d),
        pageViews: Number(r.v),
        keyEvents: Number(r.k),
      })),
      conversions: conv.map((c) => ({ landing: c.landing, conversions: Number(c.n) })),
      ...(q.sort ? { sort: q.sort } : {}),
    });
    return {
      connected: !!p.ga4PropertyId,
      period: q.period,
      from,
      to,
      gscUntil: last.gsc,
      ga4Until: last.ga4,
      totals: {
        gscClicks: Math.round(gscRows.reduce((s, r) => s + Number(r.c), 0)),
        ga4: ga4Total ? seoGa4Metrics(ga4Total) : null,
        conversions: conv.reduce((s, c) => s + Number(c.n), 0),
      },
      items,
    };
  }

  /** Las cifras de GA4 de una página (ficha de la página o de la palabra), 90 días por defecto. */
  async page(
    owner: SeoOwner | undefined,
    projectId: string,
    url: string,
    days = 90,
  ): Promise<SeoGa4PageDetailDto> {
    const p = await this.projects.resolveProject(owner, projectId);
    const landing = /^[a-z]+:\/\//i.test(url.trim()) ? seoPageLandingKey(url) : seoLandingKey(url);
    const last = await this.lastDates(p, []);
    const to = last.ga4 ?? shiftDate(today(), -1);
    const from = shiftDate(to, -(Math.max(1, Math.min(days, 486)) - 1));
    const rows = await this.admin.$queryRaw<
      { d: Date; s: number; u: number; e: number; dur: number; v: number; k: number }[]
    >(Prisma.sql`
      SELECT date AS d, SUM(sessions)::float8 AS s, SUM(users)::float8 AS u,
             SUM(engaged_sessions)::float8 AS e, SUM(duration_seconds)::float8 AS dur,
             SUM(page_views)::float8 AS v, SUM(key_events)::float8 AS k
      FROM seo_ga4_landing_daily
      WHERE project_id = ${projectId}::uuid AND landing_path = ${landing}
        AND date BETWEEN ${from}::date AND ${to}::date
      GROUP BY date ORDER BY date`);
    const sums: SeoGa4Sums = {
      sessions: 0,
      users: 0,
      engagedSessions: 0,
      durationSeconds: 0,
      pageViews: 0,
      keyEvents: 0,
    };
    for (const r of rows) {
      sums.sessions += Number(r.s);
      sums.users += Number(r.u);
      sums.engagedSessions += Number(r.e);
      sums.durationSeconds += Number(r.dur);
      sums.pageViews += Number(r.v);
      sums.keyEvents += Number(r.k);
    }
    return {
      connected: !!p.ga4PropertyId,
      landing,
      from,
      to,
      metrics: rows.length ? seoGa4Metrics(sums) : null,
      daily: rows.map((r) => ({
        date: r.d.toISOString().slice(0, 10),
        sessions: Number(r.s),
        engagedSessions: Number(r.e),
      })),
    };
  }

  // ---------------------------------------------- oportunidades e informes

  /** ¿Hay datos de GA4 del proyecto en el periodo? (barato, antes de pedir páginas). */
  async hasData(projectId: string, period: { from: string; to: string }): Promise<boolean> {
    const row = await this.admin.seoGa4LandingDaily.findFirst({
      where: {
        projectId,
        date: { gte: asDate(period.from), lte: asDate(period.to) },
      },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Para el factor «Mucho tráfico y poca interacción»: sesiones de GA4 de la
   * página ganadora de cada búsqueda en el periodo (clave: la búsqueda
   * normalizada). Solo las páginas con datos.
   */
  async pageStatsByQuery(
    projectId: string,
    period: { from: string; to: string },
    queryPages: Map<string, string>,
  ): Promise<Record<string, SeoPageEngagementStat>> {
    if (queryPages.size === 0) return {};
    const rows = await this.admin.$queryRaw<{ landing: string; s: number; e: number }[]>(Prisma.sql`
      SELECT landing_path AS landing, SUM(sessions)::float8 AS s, SUM(engaged_sessions)::float8 AS e
      FROM seo_ga4_landing_daily
      WHERE project_id = ${projectId}::uuid AND date BETWEEN ${period.from}::date AND ${period.to}::date
      GROUP BY landing_path`);
    const byLanding = new Map(rows.map((r) => [r.landing, r]));
    const out: Record<string, SeoPageEngagementStat> = {};
    for (const [query, page] of queryPages) {
      const r = byLanding.get(seoPageLandingKey(page));
      if (r && Number(r.s) > 0) {
        out[normalizeSeoKeyword(query)] = {
          sessions: Number(r.s),
          engagedSessions: Number(r.e),
        };
      }
    }
    return out;
  }

  /** Lo del informe: sesiones del periodo frente al anterior. null sin GA4. */
  async reportSummary(
    projectId: string,
    period: { from: string; to: string; previousFrom: string; previousTo: string },
  ): Promise<SeoReportGa4Dto | null> {
    const p = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      select: { ga4PropertyId: true },
    });
    if (!p?.ga4PropertyId) return null;
    const [cur, prev] = await Promise.all([
      this.ga4Sums(projectId, period.from, period.to, null),
      this.ga4Sums(projectId, period.previousFrom, period.previousTo, null),
    ]);
    if (!cur) return null;
    const m = seoGa4Metrics(cur);
    return {
      sessions: m.sessions,
      previousSessions: prev ? prev.sessions : null,
      engagementRate: m.engagementRate,
      keyEvents: m.keyEvents,
    };
  }
}
