import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_CRAWLER_ROBOTS_TOKEN,
  SEO_CRAWL_KEEP,
  SEO_CRAWL_MAX_SITEMAPS,
  SEO_SEVERITIES,
  analyzeSeoCrawl,
  compareSeoCrawlIssues,
  normalizeSeoUrl,
  parseSeoRobotsTxt,
  parseSeoSitemap,
  seoCrawlDue,
  seoCrawlExcluded,
  seoCrawlInSite,
  seoCrawlSettingsOf,
  seoCrawlSiteOf,
  seoInspectionUrlKey,
  seoRobotsAllowed,
  seoRobotsRulesFor,
  type SeoCrawlIssueType,
  type SeoCrawlPageFacts,
  type SeoCrawlRobotsDto,
  type SeoCrawlScope,
  type SeoCrawlSettings,
  type SeoCrawlSite,
  type SeoCrawlSource,
  type SeoCrawlStartResultDto,
  type SeoCrawlTrigger,
  type SeoRobotsTxt,
  type SeoSeverity,
  type UpdateSeoCrawlSettingsInput,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { isUniqueViolation } from '../../../common/prisma-errors';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { JOB_SEO_CRAWL, QUEUE_SEO_CRAWL } from '../../queues/queue-names';
import { SeoOpportunityScheduler } from '../opportunities/seo-opportunity-scheduler';
import { seoProjectEligible } from '../reports/seo-eligible';
import {
  SeoProjectsService,
  type ProjectRow,
  type SeoActor,
  type SeoOwner,
} from '../seo-projects.service';

import { crawlDto, type CrawlRow } from './seo-crawl-dto';
import { CRAWL_ERROR_TEXT, SeoCrawlFetcher, type CrawlFetchResult } from './seo-crawl-fetcher';
import { parseSeoHtml, seoRobotsDirectives } from './seo-html';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Un rastreo «en curso» sin señal desde hace esto se puede retomar (el proceso murió). */
const STALE_MS = 3 * 60_000;
/** Días de Search Console para las páginas con impresiones. */
const GSC_DAYS = 90;
/** URL de hallazgos de indexación abiertos que se piden para confirmar el motivo. */
const MAX_FINDING_SEEDS = 200;
/** Páginas guardadas como mucho por rastreo (también las bloqueadas, que no se piden). */
const ROW_FACTOR = 2;
export const seoCrawlJobId = (crawlId: string) => `seo-crawl-${crawlId}`;

/** Lo que hace falta de un dominio del proyecto. */
interface CrawlDomain {
  id: string;
  domain: string;
  role: string;
  gscProperty: string;
}

/** Lo que se guarda al empezar para poder seguir tras un reinicio. */
interface CrawlState {
  prepared?: boolean;
  robotsTxt?: string | null;
  sitemapUrls?: string[];
  gscSeeds?: { url: string; impressions: number }[];
  findingSeeds?: string[];
}

interface QueueItem {
  url: string;
  key: string;
  source: SeoCrawlSource;
}

/** Texto de un código de error del rastreo. */
export const crawlErrorText = (code: string | null): string | null =>
  code ? (CRAWL_ERROR_TEXT[code] ?? code) : null;

/** Día de la semana y hora de ahora en España. */
function madridNow(now: Date): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
}

/**
 * Rastreador de las webs de los proyectos (PR 10). Un rastreo vivo como mucho
 * por proyecto; corre en la cola `seo-crawl` (en el worker), se puede cancelar
 * y, si el proceso se reinicia, sigue donde iba (las páginas ya guardadas no
 * se vuelven a pedir). Solo pide páginas de los dominios del proyecto, con su
 * robots.txt, pausa entre peticiones y topes de páginas, tamaño y tiempo.
 */
@Injectable()
export class SeoCrawlerService {
  private readonly logger = new Logger(SeoCrawlerService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly fetcher: SeoCrawlFetcher,
    private readonly opportunities: SeoOpportunityScheduler,
    @InjectQueue(QUEUE_SEO_CRAWL) private readonly queue: Queue,
  ) {}

  /** Pausa entre peticiones que manda sobre la de los ajustes (en pruebas, 0). */
  pauseOverrideMs: number | null = process.env.NODE_ENV === 'test' ? 0 : null;

  scopeOf(project: { tenantId: string | null }): SeoCrawlScope {
    return project.tenantId ? 'tenant' : 'platform';
  }

  settingsOf(project: { tenantId: string | null; crawlSettings: unknown }): SeoCrawlSettings {
    return seoCrawlSettingsOf(project.crawlSettings, this.scopeOf(project));
  }

  async updateSettings(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoCrawlSettingsInput,
  ): Promise<SeoCrawlSettings> {
    const project = await this.projects.resolveProject(owner, projectId);
    const scope = this.scopeOf(project);
    const { reset, ...rest } = input;
    const current = reset ? seoCrawlSettingsOf(null, scope) : this.settingsOf(project);
    const clean = seoCrawlSettingsOf({ ...current, ...rest }, scope);
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { crawlSettings: clean as unknown as Prisma.InputJsonValue },
    });
    return clean;
  }

  // ----------------------------------------------------------- dominios

  /** El sitio que se rastrea: el del dominio principal. */
  siteOf(project: ProjectRow): SeoCrawlSite {
    const primary =
      project.domains.find((d) => d.role === 'primary') ??
      project.domains.find((d) => d.role !== 'redirect');
    if (!primary) {
      throw new BadRequestException({
        code: 'seo_no_domain',
        message: 'El proyecto no tiene ningún dominio que rastrear.',
      });
    }
    return seoCrawlSiteOf(primary.gscProperty, primary.domain);
  }

  /** Hosts a los que se puede pedir: los dominios del proyecto, con y sin `www.`. */
  allowedHosts(project: { domains: { domain: string }[] }): Set<string> {
    const out = new Set<string>();
    for (const d of project.domains) {
      const h = d.domain
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.$/, '');
      out.add(h);
      out.add(`www.${h}`);
    }
    return out;
  }

  // --------------------------------------------------------- arrancar y parar

  /**
   * Lanza un rastreo. Si ya hay uno vivo (en cola o en curso), devuelve ese:
   * nunca hay dos a la vez en un proyecto.
   */
  async start(
    owner: SeoOwner | undefined,
    projectId: string,
    actor: SeoActor = {},
    trigger: SeoCrawlTrigger = 'manual',
  ): Promise<SeoCrawlStartResultDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const site = this.siteOf(project);
    const live = await this.live(projectId);
    if (live) {
      await this.addJob(live.id);
      return { crawl: crawlDto(live), alreadyRunning: true };
    }
    let row: CrawlRow;
    try {
      row = await this.admin.seoCrawl.create({
        data: {
          tenantId: project.tenantId,
          projectId,
          trigger,
          startUrl: site.startUrl,
          site: site as unknown as Prisma.InputJsonValue,
          createdByUserId: actor.userId ?? null,
          createdBySuperAdminId: actor.superAdminId ?? null,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.live(projectId);
      if (!raced) throw err;
      return { crawl: crawlDto(raced), alreadyRunning: true };
    }
    await this.addJob(row.id);
    return { crawl: crawlDto(row), alreadyRunning: false };
  }

  private live(projectId: string): Promise<CrawlRow | null> {
    return this.admin.seoCrawl.findFirst({
      where: { projectId, status: { in: ['queued', 'running'] } },
    });
  }

  private async addJob(crawlId: string): Promise<void> {
    try {
      await this.queue.add(
        JOB_SEO_CRAWL,
        { crawlId },
        {
          jobId: seoCrawlJobId(crawlId),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (err) {
      this.logger.warn(`No se pudo poner el rastreo en la cola: ${(err as Error).message}`);
    }
  }

  /** Cancela un rastreo (si está en curso, para tras la página que está pidiendo). */
  async cancel(owner: SeoOwner, projectId: string, crawlId: string): Promise<void> {
    await this.projects.resolveProject(owner, projectId);
    const res = await this.admin.seoCrawl.updateMany({
      where: { id: crawlId, projectId, status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    if (res.count === 0) {
      const exists = await this.admin.seoCrawl.count({ where: { id: crawlId, projectId } });
      if (!exists) throw new NotFoundException({ code: 'not_found', message: 'No existe.' });
    }
    const job = await this.queue.getJob(seoCrawlJobId(crawlId)).catch(() => undefined);
    if (job && (await job.isWaiting().catch(() => false)))
      await job.remove().catch(() => undefined);
  }

  /** Tras reiniciar: vuelve a poner en la cola lo que quedó en cola o a medias. */
  async resumePending(): Promise<number> {
    const rows = await this.admin.seoCrawl.findMany({
      where: { status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    for (const r of rows) await this.addJob(r.id);
    return rows.length;
  }

  /**
   * Cron cada hora: el rastreo semanal de los proyectos que lo tienen
   * activado en este día y hora (España). En los tenants va apagado por
   * defecto; en la plataforma, encendido.
   */
  async scheduleDue(now = new Date()): Promise<number> {
    const projects = await this.admin.seoProject.findMany({
      where: { status: 'active' },
      select: { id: true, tenantId: true, crawlSettings: true },
    });
    const { weekday, hour } = madridNow(now);
    let n = 0;
    for (const p of projects) {
      const settings = this.settingsOf(p);
      if (!settings.weeklyEnabled) continue;
      const last = await this.admin.seoCrawl.findFirst({
        where: { projectId: p.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (
        !seoCrawlDue({
          settings,
          weekday,
          hour,
          lastStartedAt: last?.createdAt.toISOString() ?? null,
          now,
        })
      )
        continue;
      if (!(await seoProjectEligible(this.admin, p.tenantId))) continue;
      try {
        const res = await this.start(undefined, p.id, {}, 'scheduled');
        if (!res.alreadyRunning) n++;
      } catch (err) {
        this.logger.warn(`[seo-crawl] semanal de ${p.id}: ${(err as Error).message}`);
      }
    }
    return n;
  }

  // -------------------------------------------------------------- el rastreo

  /** Hace (o sigue) un rastreo. No lanza: un fallo queda en la fila. */
  async process(crawlId: string): Promise<void> {
    const now = new Date();
    // Solo uno lo procesa: uno en cola, o uno «en curso» sin señal (el proceso murió).
    const claim = await this.admin.$executeRaw(Prisma.sql`
      UPDATE seo_crawls SET status = 'running', heartbeat_at = ${now},
        started_at = COALESCE(started_at, ${now}), updated_at = ${now}
      WHERE id = ${crawlId}::uuid AND (status = 'queued' OR (status = 'running'
        AND (heartbeat_at IS NULL OR heartbeat_at < ${new Date(now.getTime() - STALE_MS)})))`);
    if (claim === 0) return;
    let crawl = await this.admin.seoCrawl.findUnique({ where: { id: crawlId } });
    if (!crawl) return;
    const project = await this.admin.seoProject.findUnique({
      where: { id: crawl.projectId },
      include: { domains: true },
    });
    if (!project) return;
    if (project.status !== 'active') {
      await this.finish(crawlId, 'cancelled', 'El proyecto está en pausa.');
      return;
    }
    if (!(await seoProjectEligible(this.admin, project.tenantId))) {
      await this.finish(crawlId, 'cancelled', 'El negocio ya no tiene SEO Avanzado.');
      return;
    }
    try {
      const settings = this.settingsOf(project);
      const site = crawl.site as unknown as SeoCrawlSite;
      const hosts = this.allowedHosts(project);
      const allowHost = (h: string) => hosts.has(h);
      let state = (crawl.state ?? {}) as CrawlState;
      if (!state.prepared) {
        const prepared = await this.prepare(crawl.id, project, site, settings, allowHost);
        if (prepared === null) return;
        state = prepared;
        crawl = (await this.admin.seoCrawl.findUnique({ where: { id: crawlId } }))!;
      }
      const robots = state.robotsTxt ? parseSeoRobotsTxt(state.robotsTxt) : null;
      const stop = await this.crawlPages(crawl, project, site, settings, state, robots, allowHost);
      if (stop === 'stopped') return;
      await this.finalize(crawlId, project, site, settings, state, stop);
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      this.logger.warn(`Rastreo ${crawlId} falló: ${message}`);
      await this.finish(crawlId, 'failed', message);
    }
  }

  /**
   * Primer paso: robots.txt, los mapas del sitio, las páginas con impresiones
   * de Search Console y las URL de los hallazgos de indexación abiertos.
   * Devuelve null si el rastreo no puede seguir (y lo deja anotado).
   */
  private async prepare(
    crawlId: string,
    project: { id: string; tenantId: string | null; domains: CrawlDomain[] },
    site: SeoCrawlSite,
    settings: SeoCrawlSettings,
    allowHost: (h: string) => boolean,
  ): Promise<CrawlState | null> {
    const origin = site.startUrl.replace(/^(https?:\/\/[^/]+).*$/i, '$1');
    // robots.txt: sin él (4xx) vale todo; si no responde (5xx o error), no se
    // rastrea (Google tampoco lo hace).
    const r = await this.fetcher.fetch(`${origin}/robots.txt`, {
      allowHost,
      accept: 'text/plain,*/*;q=0.5',
      readBody: () => true,
    });
    let robotsTxt: string | null = null;
    if (r.error || (r.finalStatus !== null && r.finalStatus >= 500)) {
      await this.finish(
        crawlId,
        'failed',
        `robots.txt no responde (${crawlErrorText(r.error) ?? r.finalStatus}): no se rastrea hasta que funcione (Google tampoco lo hace).`,
      );
      return null;
    }
    if (r.finalStatus !== null && r.finalStatus >= 200 && r.finalStatus < 300 && r.body) {
      robotsTxt = r.body.slice(0, 500_000);
    }
    const robots = robotsTxt ? parseSeoRobotsTxt(robotsTxt) : null;

    // Mapas del sitio (solo de los dominios del proyecto).
    const declared = robots?.sitemaps ?? [];
    const queue = declared.length > 0 ? [...declared] : [`${origin}/sitemap.xml`];
    const files: string[] = [];
    const errors: { url: string; error: string }[] = [];
    const urls = new Set<string>();
    let outOfScope = 0;
    const cap = settings.maxPages * ROW_FACTOR;
    const seenFiles = new Set<string>();
    while (queue.length > 0 && seenFiles.size < SEO_CRAWL_MAX_SITEMAPS) {
      const u = queue.shift()!;
      if (seenFiles.has(u)) continue;
      seenFiles.add(u);
      let host = '';
      try {
        host = new URL(u).hostname.toLowerCase();
      } catch {
        errors.push({ url: u, error: 'no es una dirección válida' });
        continue;
      }
      if (!allowHost(host)) {
        errors.push({ url: u, error: 'es de otro dominio: no se lee' });
        continue;
      }
      if (/\.gz($|\?)/i.test(u)) {
        errors.push({ url: u, error: 'está comprimido (.gz): no se lee' });
        continue;
      }
      if (this.pause(settings) > 0) await sleep(this.pause(settings));
      const res = await this.fetcher.fetch(u, {
        allowHost,
        accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
        readBody: () => true,
      });
      if (res.error || res.finalStatus === null || res.finalStatus >= 400 || !res.body) {
        // El /sitemap.xml que se prueba por defecto y no existe no es un error
        // (sale «sin mapa del sitio»); uno declarado o de un índice, sí.
        const guessed = declared.length === 0 && files.length === 0;
        if (!(guessed && res.finalStatus === 404)) {
          errors.push({
            url: u,
            error: res.error
              ? crawlErrorText(res.error)!
              : `responde ${res.finalStatus ?? 'sin código'}`,
          });
        }
        continue;
      }
      if (!/<(urlset|sitemapindex)[\s>]/i.test(res.body)) {
        errors.push({ url: u, error: 'no es un mapa del sitio (XML) válido' });
        continue;
      }
      files.push(u);
      const parsed = parseSeoSitemap(res.body);
      if (parsed.index) {
        queue.push(...parsed.urls);
        continue;
      }
      for (const x of parsed.urls) {
        if (!seoCrawlInSite(x, site)) {
          outOfScope++;
          continue;
        }
        if (urls.size < cap) urls.add(x);
      }
    }

    // Páginas con impresiones (90 días) del dominio principal.
    const primary =
      project.domains.find((d) => d.role === 'primary') ??
      project.domains.find((d) => d.role !== 'redirect');
    const gscSeeds: { url: string; impressions: number }[] = [];
    if (primary) {
      const rows = await this.admin.$queryRaw<{ page: string; i: number }[]>(Prisma.sql`
        SELECT page, SUM(impressions)::float8 AS i FROM seo_gsc_metrics
        WHERE domain_id = ${primary.id}::uuid AND grain = 'page' AND page <> ''
          AND date >= (CURRENT_DATE - ${GSC_DAYS}::int)
        GROUP BY page HAVING SUM(impressions) > 0
        ORDER BY i DESC LIMIT ${cap}`);
      for (const row of rows) {
        if (seoCrawlInSite(row.page, site)) {
          gscSeeds.push({ url: row.page, impressions: Math.round(Number(row.i)) });
        }
      }
    }
    // URL de los hallazgos de indexación abiertos (para confirmar su motivo).
    const findings = await this.admin.seoIndexFinding.findMany({
      where: { projectId: project.id, active: true, status: { in: ['new', 'reviewed'] } },
      orderBy: { impressions: 'desc' },
      select: { url: true },
      take: MAX_FINDING_SEEDS,
    });
    const findingSeeds = findings
      .map((f) => f.url)
      .filter((u) => {
        try {
          return allowHost(new URL(u).hostname.toLowerCase());
        } catch {
          return false;
        }
      });

    const state: CrawlState = {
      prepared: true,
      robotsTxt,
      sitemapUrls: [...urls],
      gscSeeds,
      findingSeeds,
    };
    const robotsDto: SeoCrawlRobotsDto = {
      found: robotsTxt !== null,
      rules: robots
        ? seoRobotsRulesFor(robots, SEO_CRAWLER_ROBOTS_TOKEN).map(
            (x) => `${x.allow ? 'Allow' : 'Disallow'}: ${x.pattern}`,
          )
        : [],
      sitemaps: declared,
      blocked: [],
      blockedCount: 0,
    };
    await this.admin.seoCrawl.update({
      where: { id: crawlId },
      data: {
        state: state as unknown as Prisma.InputJsonValue,
        robots: robotsDto as unknown as Prisma.InputJsonValue,
        sitemaps: {
          urls: files,
          pages: urls.size,
          outOfScope,
          errors,
        } as unknown as Prisma.InputJsonValue,
        heartbeatAt: new Date(),
      },
    });
    return state;
  }

  private pause(settings: SeoCrawlSettings): number {
    return this.pauseOverrideMs ?? settings.pauseMs;
  }

  /**
   * Pide las páginas: primero las que se descubren por enlaces (en anchura
   * desde la portada), luego las del mapa del sitio, las que tienen
   * impresiones y las de los hallazgos de indexación. Lo ya guardado no se
   * vuelve a pedir (así sigue tras un reinicio).
   */
  private async crawlPages(
    crawl: CrawlRow,
    project: { id: string; tenantId: string | null },
    site: SeoCrawlSite,
    settings: SeoCrawlSettings,
    state: CrawlState,
    robots: SeoRobotsTxt | null,
    allowHost: (h: string) => boolean,
  ): Promise<'stopped' | 'max_pages' | 'max_time' | null> {
    const started = (crawl.startedAt ?? new Date()).getTime();
    const deadline = started + settings.maxMinutes * 60_000;
    const sitemapKeys = new Set((state.sitemapUrls ?? []).map((u) => normalizeSeoUrl(u)));
    const impressions = new Map<string, number>();
    for (const s of state.gscSeeds ?? []) {
      const k = normalizeSeoUrl(s.url);
      impressions.set(k, (impressions.get(k) ?? 0) + s.impressions);
    }

    // Lo que ya se guardó (reanudación) y los enlaces pendientes.
    const stored = await this.admin.seoCrawlPage.findMany({
      where: { crawlId: crawl.id },
      select: { urlKey: true, links: true, linkKeys: true, inScope: true, canonical: true },
    });
    const visited = new Set(stored.map((s) => s.urlKey));
    let fetched = await this.admin.seoCrawlPage.count({
      where: { crawlId: crawl.id, status: { not: null } },
    });
    let rows = stored.length;
    const linkQueue: QueueItem[] = [];
    const queued = new Set<string>();
    const enqueue = (list: QueueItem[], url: string, source: SeoCrawlSource) => {
      const key = normalizeSeoUrl(url);
      if (visited.has(key) || queued.has(key)) return;
      queued.add(key);
      list.push({ url, key, source });
    };
    enqueue(linkQueue, site.startUrl, 'home');
    for (const s of stored) {
      if (!s.inScope) continue;
      for (const l of s.links) {
        if (seoCrawlInSite(l, site) && !seoCrawlExcluded(l, settings.excludePaths))
          enqueue(linkQueue, l, 'link');
      }
      if (s.canonical && seoCrawlInSite(s.canonical, site))
        enqueue(linkQueue, s.canonical, 'canonical');
    }
    const seeds: QueueItem[] = [];
    for (const u of state.sitemapUrls ?? []) {
      if (!seoCrawlExcluded(u, settings.excludePaths)) enqueue(seeds, u, 'sitemap');
    }
    for (const g of state.gscSeeds ?? []) {
      if (!seoCrawlExcluded(g.url, settings.excludePaths)) enqueue(seeds, g.url, 'gsc');
    }
    const findingQueue: QueueItem[] = [];
    for (const f of state.findingSeeds ?? []) enqueue(findingQueue, f, 'finding');

    const blocked: string[] = [];
    let blockedCount = 0;
    const next = (): QueueItem | null =>
      linkQueue.shift() ?? seeds.shift() ?? findingQueue.shift() ?? null;
    const maxRows = settings.maxPages * ROW_FACTOR;

    for (let item = next(); item; item = next()) {
      if (visited.has(item.key)) continue;
      if (fetched >= settings.maxPages || rows >= maxRows) {
        return (await this.stillRunning(crawl.id)) ? 'max_pages' : 'stopped';
      }
      if (Date.now() > deadline)
        return (await this.stillRunning(crawl.id)) ? 'max_time' : 'stopped';
      visited.add(item.key);
      const inScope = seoCrawlInSite(item.url, site);
      const ours = seoRobotsAllowed(robots, SEO_CRAWLER_ROBOTS_TOKEN, item.url);
      const google = seoRobotsAllowed(robots, 'googlebot', item.url);
      const base = {
        tenantId: project.tenantId,
        projectId: project.id,
        crawlId: crawl.id,
        url: item.url,
        urlKey: item.key,
        source: item.source,
        inScope,
        inSitemap: sitemapKeys.has(item.key),
        impressions: impressions.get(item.key) ?? 0,
        googleBlocked: !google.allowed,
        robotsRule: ours.allowed ? (google.allowed ? null : google.rule) : ours.rule,
      };
      if (!ours.allowed) {
        // No se pide: robots.txt no deja a este rastreador.
        blockedCount++;
        if (blocked.length < 20) blocked.push(item.url);
        await this.savePage({ ...base, robotsBlocked: true });
        rows++;
        if (!(await this.beat(crawl.id, fetched, visited.size + linkQueue.length + seeds.length)))
          return 'stopped';
        continue;
      }
      const pause = this.pause(settings);
      if (pause > 0 && fetched > 0) await sleep(pause);
      const res = await this.fetcher.fetch(item.url, { allowHost });
      fetched++;
      rows++;
      const page = this.pageData(res, item, site);
      await this.savePage({ ...base, ...page });
      // Enlaces del sitio (y su canónica) a la cola.
      if (inScope && page.isHtml) {
        for (const l of page.links) {
          if (seoCrawlInSite(l, site) && !seoCrawlExcluded(l, settings.excludePaths))
            enqueue(linkQueue, l, 'link');
        }
        if (page.canonical && seoCrawlInSite(page.canonical, site))
          enqueue(linkQueue, page.canonical, 'canonical');
      }
      // Una redirección dentro del sitio: el destino también se mira.
      if (
        inScope &&
        page.status !== null &&
        page.status >= 300 &&
        page.status < 400 &&
        page.finalUrl &&
        seoCrawlInSite(page.finalUrl, site)
      ) {
        enqueue(linkQueue, page.finalUrl, 'link');
      }
      if (!(await this.beat(crawl.id, fetched, visited.size + linkQueue.length + seeds.length)))
        return 'stopped';
    }
    await this.admin.seoCrawl.update({
      where: { id: crawl.id },
      data: {
        robots: {
          ...((crawl.robots ?? {}) as object),
          blocked,
          blockedCount,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return null;
  }

  /** Anota que sigue vivo y cuánto lleva; false si lo han cancelado. */
  private async beat(crawlId: string, fetched: number, found: number): Promise<boolean> {
    const res = await this.admin.seoCrawl.updateMany({
      where: { id: crawlId, status: 'running' },
      data: { heartbeatAt: new Date(), pagesCrawled: fetched, pagesFound: found },
    });
    return res.count > 0;
  }

  private async stillRunning(crawlId: string): Promise<boolean> {
    const r = await this.admin.seoCrawl.findUnique({
      where: { id: crawlId },
      select: { status: true },
    });
    return r?.status === 'running';
  }

  /** Lo que se guarda de una respuesta. */
  private pageData(res: CrawlFetchResult, item: QueueItem, site: SeoCrawlSite) {
    const ct = res.contentType;
    const isHtml = !!ct && /text\/html|application\/xhtml\+xml/i.test(ct) && !!res.body;
    // Una variante de la misma página (http, www, barra final) que redirige a
    // ella se toma por ella: se analiza lo que llega al final.
    const sameKey =
      res.chain.length > 0 &&
      res.finalStatus !== null &&
      normalizeSeoUrl(res.finalUrl) === item.key;
    const status = sameKey ? res.finalStatus : res.status;
    const parsed =
      isHtml && status !== null && status >= 200 && status < 300
        ? parseSeoHtml(res.body!, res.finalUrl)
        : null;
    const robots = seoRobotsDirectives(parsed?.robots ?? '', res.headers['x-robots-tag']);
    const internal: string[] = [];
    let external = 0;
    for (const l of parsed?.links ?? []) {
      if (seoCrawlInSite(l.href, site)) internal.push(l.href);
      else external++;
    }
    const links = [...new Set(internal)].slice(0, 1000);
    return {
      status,
      finalStatus: res.finalStatus,
      finalUrl: res.chain.length > 0 ? res.finalUrl : null,
      redirectChain: res.chain,
      error: crawlErrorText(res.error),
      responseMs: res.ms,
      contentType: ct ? ct.slice(0, 200) : null,
      isHtml: !!parsed,
      robotsBlocked: false,
      title: parsed?.title?.slice(0, 1000) ?? null,
      description: parsed?.description?.slice(0, 2000) ?? null,
      h1: (parsed?.h1 ?? []).slice(0, 10).map((h) => h.slice(0, 500)),
      canonical: parsed?.canonical ?? null,
      noindex: robots.noindex,
      nofollow: robots.nofollow,
      hreflang: (parsed?.hreflang ?? []).slice(0, 50),
      jsonLdTypes: (parsed?.jsonLdTypes ?? []).slice(0, 30),
      jsonLdInvalid: parsed?.jsonLdInvalid ?? 0,
      imagesTotal: parsed?.imagesTotal ?? 0,
      imagesWithoutAlt: parsed?.imagesWithoutAlt ?? 0,
      links,
      linkKeys: [...new Set(links.map((l) => normalizeSeoUrl(l)))],
      externalLinks: external,
    };
  }

  private async savePage(data: {
    tenantId: string | null;
    projectId: string;
    crawlId: string;
    url: string;
    urlKey: string;
    source: SeoCrawlSource;
    inScope: boolean;
    inSitemap: boolean;
    impressions: number;
    googleBlocked: boolean;
    robotsRule: string | null;
    robotsBlocked: boolean;
    status?: number | null;
    finalStatus?: number | null;
    finalUrl?: string | null;
    redirectChain?: string[];
    error?: string | null;
    responseMs?: number | null;
    contentType?: string | null;
    isHtml?: boolean;
    title?: string | null;
    description?: string | null;
    h1?: string[];
    canonical?: string | null;
    noindex?: boolean;
    nofollow?: boolean;
    hreflang?: { lang: string; href: string }[];
    jsonLdTypes?: string[];
    jsonLdInvalid?: number;
    imagesTotal?: number;
    imagesWithoutAlt?: number;
    links?: string[];
    linkKeys?: string[];
    externalLinks?: number;
  }): Promise<void> {
    const { redirectChain, hreflang, ...rest } = data;
    await this.admin.seoCrawlPage
      .create({
        data: {
          ...rest,
          redirectChain: (redirectChain ?? []) as Prisma.InputJsonValue,
          hreflang: (hreflang ?? []) as Prisma.InputJsonValue,
        },
      })
      .catch((err) => {
        // Ya estaba (otro proceso la guardó a la vez): vale la suya.
        if (!isUniqueViolation(err)) throw err;
      });
  }

  // ----------------------------------------------------------- al terminar

  /**
   * Cierra el rastreo: profundidad y enlaces que llegan a cada página,
   * incidencias con su ciclo de vida (sin pisar estado ni notas; las que ya no
   * salen se resuelven solas y vuelven si reaparecen), comparación con el
   * rastreo anterior y limpieza de las páginas de los rastreos viejos.
   */
  private async finalize(
    crawlId: string,
    project: { id: string; tenantId: string | null; domains: CrawlDomain[] },
    site: SeoCrawlSite,
    settings: SeoCrawlSettings,
    state: CrawlState,
    stopReason: 'max_pages' | 'max_time' | null,
  ): Promise<void> {
    const rows = await this.admin.seoCrawlPage.findMany({ where: { crawlId } });
    const facts: SeoCrawlPageFacts[] = rows.map((r) => ({
      url: r.url,
      key: r.urlKey,
      source: r.source as SeoCrawlSource,
      inScope: r.inScope,
      status: r.status,
      finalStatus: r.finalStatus,
      finalUrl: r.finalUrl,
      redirectChain: (r.redirectChain ?? []) as string[],
      error: r.error,
      responseMs: r.responseMs,
      isHtml: r.isHtml,
      robotsBlocked: r.robotsBlocked,
      googleBlocked: r.googleBlocked,
      title: r.title,
      description: r.description,
      h1: r.h1,
      canonical: r.canonical,
      noindex: r.noindex,
      nofollow: r.nofollow,
      hreflang: (r.hreflang ?? []) as { lang: string; href: string }[],
      jsonLdTypes: r.jsonLdTypes,
      jsonLdInvalid: r.jsonLdInvalid,
      imagesTotal: r.imagesTotal,
      imagesWithoutAlt: r.imagesWithoutAlt,
      links: r.links,
      inSitemap: r.inSitemap,
      impressions: r.impressions,
    }));
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0] ?? null;
    const targets = await this.admin.seoProjectKeyword.findMany({
      where: { projectId: project.id, isActive: true, targetUrl: { not: null } },
      select: { targetUrl: true },
    });
    const targetKeys = new Set(
      targets.map((t) => seoInspectionUrlKey(t.targetUrl!, primary?.domain ?? site.host)),
    );
    const visited = new Set(rows.map((r) => r.urlKey));
    const unreached = (state.gscSeeds ?? []).filter(
      (g) =>
        !visited.has(normalizeSeoUrl(g.url)) && !seoCrawlExcluded(g.url, settings.excludePaths),
    );
    const crawl = await this.admin.seoCrawl.findUniqueOrThrow({ where: { id: crawlId } });
    const sitemaps = (crawl.sitemaps ?? {}) as {
      urls?: string[];
      errors?: { url: string; error: string }[];
    };
    const analysis = analyzeSeoCrawl({
      pages: facts,
      homeKey: normalizeSeoUrl(site.startUrl),
      targetKeys,
      sitemapFound: (sitemaps.urls ?? []).length > 0,
      sitemapErrors: sitemaps.errors ?? [],
      unreached,
    });
    const now = new Date();

    // Profundidad, enlaces que llegan e incidencias de cada página.
    const issuesByUrl = new Map<string, number>();
    for (const i of analysis.issues) {
      const k = normalizeSeoUrl(i.url);
      issuesByUrl.set(k, (issuesByUrl.get(k) ?? 0) + 1);
    }
    const updates = rows.map((r) => ({
      id: r.id,
      depth: analysis.depth.get(r.urlKey) ?? null,
      inlinks: analysis.inlinks.get(r.urlKey)?.length ?? 0,
      issues: issuesByUrl.get(r.urlKey) ?? 0,
    }));
    for (let i = 0; i < updates.length; i += 1000) {
      const chunk = updates.slice(i, i + 1000);
      await this.admin.$executeRaw(Prisma.sql`
        UPDATE seo_crawl_pages p SET depth = x.depth, inlinks = x.inlinks, issues = x.issues
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
          AS x(id uuid, depth int, inlinks int, issues int)
        WHERE p.id = x.id`);
    }

    // Incidencias: comparación con el rastreo anterior y ciclo de vida.
    const records = analysis.issues.map((c) => ({
      key: sha1(c.key),
      type: c.type,
      severity: c.severity,
      url: c.url,
      url_key: normalizeSeoUrl(c.url),
      detail: c.detail.slice(0, 2000),
      data: c.data,
    }));
    const result = await this.admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seo-crawl:${project.id}`}::text))`;
        const before = await tx.seoCrawlIssue.findMany({
          where: { projectId: project.id, active: true },
          select: { key: true },
        });
        if (records.length > 0) {
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO seo_crawl_issues (
              tenant_id, project_id, key, type, severity, url, url_key, detail, data,
              status, active, first_seen_at, last_seen_at, first_crawl_id, last_crawl_id,
              appeared_crawl_id, created_at, updated_at
            )
            SELECT ${project.tenantId}::uuid, ${project.id}::uuid, x.key, x.type, x.severity, x.url,
              x.url_key, x.detail, x.data, 'new', true, ${now}, ${now}, ${crawlId}::uuid,
              ${crawlId}::uuid, ${crawlId}::uuid, ${now}, ${now}
            FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS x(
              key text, type text, severity text, url text, url_key text, detail text, data jsonb
            )
            ON CONFLICT (project_id, key) DO UPDATE SET
              severity = EXCLUDED.severity,
              url = EXCLUDED.url,
              url_key = EXCLUDED.url_key,
              detail = EXCLUDED.detail,
              data = EXCLUDED.data,
              last_seen_at = EXCLUDED.last_seen_at,
              last_crawl_id = EXCLUDED.last_crawl_id,
              updated_at = EXCLUDED.updated_at,
              appeared_crawl_id = CASE WHEN seo_crawl_issues.active
                THEN seo_crawl_issues.appeared_crawl_id ELSE EXCLUDED.appeared_crawl_id END,
              returned_at = CASE WHEN NOT seo_crawl_issues.active OR seo_crawl_issues.status = 'fixed'
                THEN EXCLUDED.last_seen_at ELSE seo_crawl_issues.returned_at END,
              status = CASE WHEN seo_crawl_issues.status = 'fixed'
                THEN 'new' ELSE seo_crawl_issues.status END,
              resolved_at = NULL,
              resolved_crawl_id = NULL,
              active = true`);
        }
        // Lo que ya no sale se resuelve solo (sin tocar las notas).
        await tx.$executeRaw(Prisma.sql`
          UPDATE seo_crawl_issues SET active = false, resolved_at = ${now},
            resolved_crawl_id = ${crawlId}::uuid, updated_at = ${now},
            status = CASE WHEN status IN ('new', 'reviewed') THEN 'fixed' ELSE status END
          WHERE project_id = ${project.id}::uuid AND active
            AND (last_crawl_id IS NULL OR last_crawl_id <> ${crawlId}::uuid)`);
        return compareSeoCrawlIssues(
          new Set(before.map((b) => b.key)),
          new Set(records.map((r) => r.key)),
        );
      },
      { timeout: 120_000 },
    );

    const bySeverity = Object.fromEntries(SEO_SEVERITIES.map((s) => [s, 0])) as Record<
      SeoSeverity,
      number
    >;
    const byType: Partial<Record<SeoCrawlIssueType, number>> = {};
    for (const i of analysis.issues) {
      bySeverity[i.severity]++;
      byType[i.type] = (byType[i.type] ?? 0) + 1;
    }
    const errors = rows.filter(
      (r) => r.inScope && (r.error !== null || (r.status !== null && r.status >= 400)),
    ).length;
    await this.admin.seoCrawl.updateMany({
      where: { id: crawlId, status: 'running' },
      data: {
        status: 'done',
        finishedAt: now,
        stopReason,
        errors,
        pagesCrawled: rows.filter((r) => r.status !== null || r.error !== null).length,
        summary: { bySeverity, byType, ...result } as unknown as Prisma.InputJsonValue,
      },
    });
    // Las alertas se revisan antes (la hora siguiente) y las oportunidades se recalculan.
    await this.admin.seoProject.update({
      where: { id: project.id },
      data: { technicalUpdatedAt: now },
    });
    await this.opportunities.schedule(project.id);
    await this.prune(project.id);
    this.logger.log(
      `Rastreo ${crawlId}: ${rows.length} URL, ${analysis.issues.length} incidencias (${result.newIssues} nuevas, ${result.resolvedIssues} resueltas)`,
    );
  }

  /** Solo se conservan las páginas de los últimos rastreos de cada proyecto. */
  async prune(projectId: string): Promise<number> {
    const keep = await this.admin.seoCrawl.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      take: SEO_CRAWL_KEEP,
    });
    const res = await this.admin.seoCrawlPage.deleteMany({
      where: { projectId, crawlId: { notIn: keep.map((k) => k.id) } },
    });
    return res.count;
  }

  private async finish(
    crawlId: string,
    status: 'failed' | 'cancelled',
    error: string | null,
  ): Promise<void> {
    await this.admin.seoCrawl.updateMany({
      where: { id: crawlId, status: { in: ['queued', 'running'] } },
      data: { status, error, finishedAt: new Date() },
    });
  }
}
