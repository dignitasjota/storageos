import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_PAGESPEED_HISTORY_MAX,
  SEO_PAGESPEED_STRATEGIES,
  seoAbsoluteUrl,
  seoInspectionUrlKey,
  selectSeoPageSpeedUrls,
  seoCrawlSiteOf,
  type RunSeoPageSpeedInput,
  type SeoPageSpeedDto,
  type SeoPageSpeedHistoryDto,
  type SeoPageSpeedRunDto,
  type SeoPageSpeedStrategy,
  type SeoPageSpeedUrlDto,
  type SeoTechnicalTrigger,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { JOB_SEO_PAGESPEED, QUEUE_SEO_PAGESPEED } from '../../queues/queue-names';
import { seoProjectEligible } from '../reports/seo-eligible';
import { SeoProjectsService, type SeoActor, type SeoOwner } from '../seo-projects.service';

import { PageSpeedClient } from './pagespeed.client';
import { SeoInspectionService } from './seo-inspection.service';
import { pageSpeedDto } from './seo-technical-read.service';

/** Mediciones como mucho en cada pasada de la cola. */
const QUEUE_BATCH = 200;
/** Días de Search Console que se miran para «las páginas con más clics». */
const TOP_PAGES_DAYS = 28;
/** Una medición en curso desde hace más de esto se da por perdida y vuelve a la cola. */
const STUCK_MS = 20 * 60_000;
/** Lo que se lista en la pantalla (URL distintas). */
const LIST_MAX = 100;
/** Mediciones a mano como mucho por proyecto y día (las de un día natural, hora de España). */
export const SEO_PAGESPEED_DAILY_MANUAL = 40;
/** Fallos pasajeros seguidos tras los que la cola se corta (Google caído o sin clave). */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Espera entre un proyecto y otro al repartir la medición semanal. */
const WEEKLY_SPREAD_MS = 3 * 60_000;

/**
 * PageSpeed Insights (PR 9): bajo demanda y cada semana para la portada, las
 * URL objetivo de prioridad alta y las páginas con más clics. Cada medición
 * (URL y estrategia) es una fila: histórico conservado. PageSpeed tarda 10-30
 * segundos, así que todo pasa por la cola `seo` (en el worker).
 */
@Injectable()
export class SeoPageSpeedService {
  private readonly logger = new Logger(SeoPageSpeedService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly inspection: SeoInspectionService,
    private readonly client: PageSpeedClient,
    @InjectQueue(QUEUE_SEO_PAGESPEED) private readonly queue: Queue,
  ) {}

  // -------------------------------------------------------------- lectura

  async list(owner: SeoOwner | undefined, projectId: string): Promise<SeoPageSpeedDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const ids = await this.admin.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT DISTINCT ON (url_key, strategy) id::text AS id FROM seo_pagespeed_runs
      WHERE project_id = ${projectId}::uuid
      ORDER BY url_key, strategy, (status = 'done') DESC, created_at DESC`);
    const rows = ids.length
      ? await this.admin.seoPageSpeedRun.findMany({ where: { id: { in: ids.map((r) => r.id) } } })
      : [];
    const byUrl = new Map<string, SeoPageSpeedUrlDto & { at: number }>();
    for (const r of rows) {
      const u = byUrl.get(r.urlKey) ?? { url: r.url, mobile: null, desktop: null, at: 0 };
      u[r.strategy as SeoPageSpeedStrategy] = pageSpeedDto(r);
      u.at = Math.max(u.at, r.createdAt.getTime());
      byUrl.set(r.urlKey, u);
    }
    const pending = await this.admin.seoPageSpeedRun.count({
      where: { projectId, status: { in: ['queued', 'running'] } },
    });
    return {
      settings: this.inspection.settingsOf(project),
      keyConfigured: this.client.keyConfigured,
      urls: [...byUrl.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, LIST_MAX)
        .map(({ at: _at, ...u }) => u),
      pending,
      lastScheduledAt: project.pagespeedScheduledAt?.toISOString() ?? null,
    };
  }

  async history(
    owner: SeoOwner | undefined,
    projectId: string,
    rawUrl: string,
    strategy: SeoPageSpeedStrategy,
  ): Promise<SeoPageSpeedHistoryDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
    const key = seoInspectionUrlKey(rawUrl, primary?.domain ?? '');
    const rows = await this.admin.seoPageSpeedRun.findMany({
      where: { projectId, urlKey: key, strategy, status: 'done' },
      orderBy: [{ analyzedAt: 'desc' }],
      take: SEO_PAGESPEED_HISTORY_MAX,
    });
    return {
      url: rows[0]?.url ?? seoAbsoluteUrl(rawUrl, primary?.domain ?? ''),
      strategy,
      runs: rows.reverse().map(pageSpeedDto),
    };
  }

  // ------------------------------------------------------ bajo demanda

  /** Medir una URL del proyecto (móvil y ordenador por defecto). Queda en la cola. */
  async run(
    owner: SeoOwner,
    projectId: string,
    input: RunSeoPageSpeedInput,
    actor: SeoActor = {},
  ): Promise<SeoPageSpeedRunDto[]> {
    const t = await this.inspection.target(owner, projectId, input.url);
    const strategies = input.strategies ?? [...SEO_PAGESPEED_STRATEGIES];
    // Tope por proyecto y día: la clave de Google es de toda la plataforma.
    const since = new Date(Date.now() - 24 * 3600_000);
    const today = await this.admin.seoPageSpeedRun.count({
      where: { projectId, trigger: 'manual', createdAt: { gte: since } },
    });
    if (today + strategies.length > SEO_PAGESPEED_DAILY_MANUAL) {
      throw new BadRequestException({
        code: 'seo_pagespeed_daily_limit',
        message: `Has llegado al máximo de ${SEO_PAGESPEED_DAILY_MANUAL} mediciones al día de este proyecto. Vuelve mañana.`,
      });
    }
    await this.enqueue(
      t.project.tenantId,
      projectId,
      t.domain.id,
      [t.url],
      strategies,
      'manual',
      actor,
    );
    const rows = await this.admin.seoPageSpeedRun.findMany({
      where: {
        projectId,
        urlKey: t.urlKey,
        strategy: { in: strategies },
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    await this.schedule(projectId);
    return rows.map(pageSpeedDto);
  }

  private async enqueue(
    tenantId: string | null,
    projectId: string,
    domainId: string | null,
    urls: string[],
    strategies: SeoPageSpeedStrategy[],
    trigger: SeoTechnicalTrigger,
    actor: SeoActor = {},
  ): Promise<number> {
    const data = urls.flatMap((url) =>
      strategies.map((strategy) => ({
        tenantId,
        projectId,
        domainId,
        url,
        urlKey: seoInspectionUrlKey(url, ''),
        strategy,
        trigger,
        requestedByUserId: actor.userId ?? null,
        requestedBySuperAdminId: actor.superAdminId ?? null,
      })),
    );
    if (data.length === 0) return 0;
    // Una URL y estrategia que ya espera no se duplica (índice parcial).
    const res = await this.admin.seoPageSpeedRun.createMany({ data, skipDuplicates: true });
    return res.count;
  }

  async schedule(projectId: string, delayMs = 0): Promise<void> {
    try {
      await this.queue.add(
        JOB_SEO_PAGESPEED,
        { projectId },
        {
          jobId: `seo-psi-${projectId}-${Date.now()}`,
          ...(delayMs > 0 ? { delay: delayMs } : {}),
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 1,
        },
      );
    } catch (err) {
      this.logger.warn(`No se pudo programar la medición: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- cola

  /** Mide lo que espera de un proyecto (o de todos), una medición tras otra. */
  async processQueue(projectId?: string): Promise<{ done: number; failed: number }> {
    await this.admin.seoPageSpeedRun.updateMany({
      where: {
        ...(projectId ? { projectId } : {}),
        status: 'running',
        updatedAt: { lt: new Date(Date.now() - STUCK_MS) },
      },
      data: { status: 'queued' },
    });
    let done = 0;
    let failed = 0;
    const touched = new Set<string>();
    let consecutiveFailures = 0;
    for (let i = 0; i < QUEUE_BATCH; i++) {
      const next = await this.admin.seoPageSpeedRun.findFirst({
        where: { ...(projectId ? { projectId } : {}), status: 'queued' },
        orderBy: { createdAt: 'asc' },
      });
      if (!next) break;
      const claimed = await this.admin.seoPageSpeedRun.updateMany({
        where: { id: next.id, status: 'queued' },
        data: { status: 'running', attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue;
      touched.add(next.projectId);
      try {
        const r = await this.client.run(next.url, next.strategy as SeoPageSpeedStrategy);
        await this.admin.seoPageSpeedRun.update({
          where: { id: next.id },
          data: {
            status: 'done',
            performanceScore: r.scores.performance,
            seoScore: r.scores.seo,
            accessibilityScore: r.scores.accessibility,
            bestPracticesScore: r.scores.bestPractices,
            lcpMs: r.lab.lcpMs,
            cls: r.lab.cls,
            tbtMs: r.lab.tbtMs,
            fcpMs: r.lab.fcpMs,
            siMs: r.lab.siMs,
            ttiMs: r.lab.ttiMs,
            fieldScope: r.field?.scope ?? null,
            fieldOverall: r.field?.overall ?? null,
            fieldLcpMs: r.field?.lcpMs ?? null,
            fieldInpMs: r.field?.inpMs ?? null,
            fieldCls: r.field?.cls ?? null,
            field: r.fieldRaw as unknown as Prisma.InputJsonValue,
            opportunities: r.opportunities as unknown as Prisma.InputJsonValue,
            analyzedAt: new Date(r.analyzedAt),
            error: null,
          },
        });
        done++;
        consecutiveFailures = 0;
      } catch (err) {
        await this.admin.seoPageSpeedRun.update({
          where: { id: next.id },
          data: { status: 'error', error: (err as Error).message.slice(0, 500) },
        });
        failed++;
        // Con Google caído o sin clave, cada medición agota sus reintentos (minutos):
        // tras unos cuantos fallos seguidos se corta y el resto espera a otra pasada.
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      }
    }
    for (const id of touched) {
      await this.admin.seoProject.update({
        where: { id },
        data: { technicalUpdatedAt: new Date() },
      });
    }
    return { done, failed };
  }

  // -------------------------------------------------------- lote semanal

  /** Las URL de la semana de un proyecto (portada, objetivos importantes y más clics). */
  async enqueueWeekly(projectId: string, delayMs = 0): Promise<number> {
    const project = await this.projects.resolveProject(undefined, projectId);
    const settings = this.inspection.settingsOf(project);
    if (!settings.pagespeedEnabled || project.status !== 'active') return 0;
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
    if (!primary) return 0;
    const kws = await this.admin.seoProjectKeyword.findMany({
      where: { projectId, isActive: true, priority: 1, targetUrl: { not: null } },
      select: { targetUrl: true },
      take: 200,
    });
    let topPages: string[] = [];
    const last = primary.dataUntil?.toISOString().slice(0, 10);
    if (last) {
      const from = new Date(
        new Date(`${last}T00:00:00Z`).getTime() - (TOP_PAGES_DAYS - 1) * 86_400_000,
      );
      topPages = (
        await this.admin.$queryRaw<{ page: string }[]>(Prisma.sql`
          SELECT page FROM seo_gsc_metrics
          WHERE domain_id = ${primary.id}::uuid AND grain = 'page' AND page <> ''
            AND date BETWEEN ${from}::date AND ${last}::date
          GROUP BY page ORDER BY SUM(clicks) DESC, SUM(impressions) DESC LIMIT 50`)
      ).map((r) => r.page);
    }
    const urls = selectSeoPageSpeedUrls({
      // La portada de la propiedad (la web de un negocio en la plataforma es `/s/<negocio>/`).
      home: seoCrawlSiteOf(primary.gscProperty, primary.domain).startUrl,
      targets: kws.map((k) => seoAbsoluteUrl(k.targetUrl!, primary.domain)),
      topPages,
      max: settings.pagespeedMaxUrls,
    });
    // Solo las URL de los dominios del proyecto.
    const own: { url: string; domainId: string }[] = [];
    for (const u of urls) {
      try {
        const t = this.inspection.resolveTarget(project, u);
        own.push({ url: t.url, domainId: t.domain.id });
      } catch {
        // De otro dominio: no se mide.
      }
    }
    let n = 0;
    for (const o of own) {
      n += await this.enqueue(
        project.tenantId,
        projectId,
        o.domainId,
        [o.url],
        [...SEO_PAGESPEED_STRATEGIES],
        'batch',
      );
    }
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { pagespeedScheduledAt: new Date() },
    });
    if (n > 0) await this.schedule(projectId, delayMs);
    return n;
  }

  /**
   * Repaso periódico: lo que quedó «en cola» (un reinicio, un corte por fallos) y no
   * tiene trabajo esperando vuelve a programarse.
   */
  async scheduleDue(): Promise<number> {
    const rows = await this.admin.seoPageSpeedRun.groupBy({
      by: ['projectId'],
      where: {
        status: 'queued',
        createdAt: { lt: new Date(Date.now() - 30 * 60_000) },
      },
    });
    for (const r of rows) await this.schedule(r.projectId);
    return rows.length;
  }

  /** Cron semanal: todos los proyectos con la medición activada. */
  async enqueueWeeklyAll(): Promise<{ projects: number; queued: number }> {
    const projects = await this.admin.seoProject.findMany({
      where: { status: 'active' },
      select: { id: true, tenantId: true, technicalSettings: true },
    });
    let n = 0;
    let queued = 0;
    for (const p of projects) {
      if (!this.inspection.settingsOf(p).pagespeedEnabled) continue;
      if (!(await seoProjectEligible(this.admin, p.tenantId))) continue;
      try {
        // Repartido en el tiempo: un proyecto cada pocos minutos, no todos a la vez.
        queued += await this.enqueueWeekly(p.id, n * WEEKLY_SPREAD_MS);
        n++;
      } catch (err) {
        this.logger.warn(`[seo-psi] semana de ${p.id}: ${(err as Error).message}`);
      }
    }
    return { projects: n, queued };
  }
}
