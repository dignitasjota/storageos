import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SEO_PLATFORM_KEYWORD_LIMIT,
  SEO_SISTRIX_CACHE_DAYS,
  SEO_SISTRIX_DATA_TYPES,
  SEO_SISTRIX_LIST_LIMIT,
  SEO_SISTRIX_MANUAL_CACHE_HOURS,
  SEO_SYNC_FREQUENCY_DAYS,
  SEO_TENANT_LIMITS,
  madridToday,
  type SeoProviderKey,
  type SeoSistrixDataType,
  type SeoSistrixWaitReason,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { isUniqueViolation } from '../../../common/prisma-errors';
import { tenantHasFeature } from '../../../common/tenant-features';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { JOB_SEO_SISTRIX_SYNC, QUEUE_SEO_SISTRIX } from '../../queues/queue-names';
import { SeoOpportunityScheduler } from '../opportunities/seo-opportunity-scheduler';

import { SistrixApiClient } from './sistrix-api.client';
import { type SeoPool, SistrixConnectionsService } from './sistrix-connections.service';
import { SistrixDataError } from './sistrix-errors';
import { type FetchResult, SistrixFetchService } from './sistrix-fetch.service';
import { SistrixMcpClient } from './sistrix-mcp.client';

import type { SistrixData, SistrixQuery } from './sistrix-normalizer';
import type { Env } from '../../../config/env.schema';
import type { Prisma } from '@storageos/database';

/** Un elemento de una tanda: una consulta y a qué se refiere. */
export interface RunItem {
  q: SistrixQuery;
  /** Palabra del proyecto (resultados de Google y métricas). */
  keywordId?: string;
  status?: 'done' | 'failed';
}

interface RunProgress {
  items: RunItem[];
}

export interface SistrixActor {
  userId?: string | null;
  superAdminId?: string | null;
}

export const sistrixJobId = (runId: string) => `seo-sistrix-${runId}`;

const ACTIVE = ['queued', 'running', 'waiting'];
const day = (d: string) => new Date(`${d}T00:00:00Z`);

type ProjectRow = Prisma.SeoProjectGetPayload<{
  include: { domains: true; competitors: true };
}>;

/** Fondo de un proyecto: la plataforma, o el tenant con su clave (salvo que use la de la plataforma). */
export function poolOfProject(p: {
  tenantId: string | null;
  usePlatformSistrix: boolean;
}): SeoPool {
  return p.tenantId && !p.usePlatformSistrix ? p.tenantId : null;
}

/** Tipos de dato de SISTRIX que usa el motor de oportunidades. */
const OPPORTUNITY_DATA_TYPES: SeoSistrixDataType[] = [
  'opportunities',
  'domain_keywords',
  'keyword_metrics',
];

/**
 * Tandas de SISTRIX: se programan por proyecto y tipo de dato según la
 * frecuencia de su fondo, se procesan de una en una (cola `seo-sistrix`,
 * concurrencia 1, pausa entre llamadas) y se reanudan tras un reinicio o
 * cuando vuelve la cuota. Los datos se guardan con su proveedor y su fecha.
 */
@Injectable()
export class SistrixSyncService {
  private readonly logger = new Logger(SistrixSyncService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly connections: SistrixConnectionsService,
    private readonly fetcher: SistrixFetchService,
    private readonly api: SistrixApiClient,
    private readonly mcp: SistrixMcpClient,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_SEO_SISTRIX) private readonly queue: Queue,
    private readonly opportunities: SeoOpportunityScheduler,
  ) {}

  // ------------------------------------------------------------ programar

  /** Encola una tanda (si ya hay una viva de ese tipo en el proyecto, devuelve esa). */
  async enqueue(
    projectId: string,
    dataType: SeoSistrixDataType,
    kind: 'manual' | 'scheduled',
    actor: SistrixActor = {},
  ): Promise<string> {
    const project = await this.admin.seoProject.findUniqueOrThrow({ where: { id: projectId } });
    const active = await this.activeRun(projectId, dataType);
    if (active) {
      if (active.status !== 'waiting') await this.addJob(active.id);
      return active.id;
    }
    const pool = poolOfProject(project);
    const route = await this.fetcher.route(pool);
    let runId: string;
    try {
      const run = await this.admin.seoSyncRun.create({
        data: {
          tenantId: project.tenantId,
          projectId,
          provider: route.provider ?? (pool === null ? 'sistrix_mcp' : 'sistrix_api'),
          kind,
          dataType,
          createdByUserId: actor.userId ?? null,
          createdBySuperAdminId: actor.superAdminId ?? null,
        },
        select: { id: true },
      });
      runId = run.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.activeRun(projectId, dataType);
      if (!raced) throw err;
      return raced.id;
    }
    await this.addJob(runId);
    return runId;
  }

  private activeRun(projectId: string, dataType: SeoSistrixDataType) {
    return this.admin.seoSyncRun.findFirst({
      where: { projectId, dataType, status: { in: ACTIVE } },
      select: { id: true, status: true },
    });
  }

  async addJob(runId: string): Promise<void> {
    await this.queue.add(
      JOB_SEO_SISTRIX_SYNC,
      { runId },
      { jobId: sistrixJobId(runId), attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
  }

  async cancel(runId: string): Promise<void> {
    await this.admin.seoSyncRun.updateMany({
      where: { id: runId, status: { in: ACTIVE } },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    const job = await this.queue.getJob(sistrixJobId(runId));
    if (job && (await job.isWaiting())) await job.remove().catch(() => undefined);
  }

  /** Tras reiniciar: lo que quedó en cola o a medias vuelve a la cola. */
  async resumePending(): Promise<number> {
    const runs = await this.admin.seoSyncRun.findMany({
      where: { dataType: { not: null }, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    for (const r of runs) await this.addJob(r.id);
    return runs.length;
  }

  /**
   * Se reanuda lo que esperaba: la cuota del MCP vuelve (y con ella caduca la
   * autorización de la API) y las tandas en espera cuyo plazo pasó vuelven a
   * la cola.
   */
  async resumeWaiting(now = new Date()): Promise<number> {
    const mcp = await this.connections.find(null, 'sistrix_mcp');
    if (mcp?.quotaExhaustedUntil && mcp.quotaExhaustedUntil <= now) {
      await this.connections.update(mcp.id, { quotaExhaustedUntil: null });
      // «Continuar por API» se acaba cuando el MCP se reanuda.
      await this.admin.seoProviderConnection.updateMany({
        where: { tenantId: null, provider: 'sistrix_api', apiAuthorizedUntil: { not: null } },
        data: { apiAuthorizedUntil: null, apiAuthorizedBySuperAdminId: null },
      });
    }
    await this.admin.seoProviderConnection.updateMany({
      where: { tenantId: null, provider: 'sistrix_api', apiAuthorizedUntil: { lte: now } },
      data: { apiAuthorizedUntil: null, apiAuthorizedBySuperAdminId: null },
    });
    const runs = await this.admin.seoSyncRun.findMany({
      where: {
        dataType: { not: null },
        status: 'waiting',
        OR: [{ pausedUntil: null }, { pausedUntil: { lte: now } }],
      },
      select: { id: true },
    });
    for (const r of runs) {
      await this.admin.seoSyncRun.updateMany({
        where: { id: r.id, status: 'waiting' },
        data: { status: 'queued' },
      });
      await this.addJob(r.id);
    }
    return runs.length;
  }

  /** Vuelve a poner en la cola las tandas en espera de un fondo (p. ej. al autorizar la API). */
  async wakeWaiting(pool: SeoPool): Promise<number> {
    const runs = await this.admin.seoSyncRun.findMany({
      where: {
        dataType: { not: null },
        status: 'waiting',
        project:
          pool === null
            ? { OR: [{ tenantId: null }, { usePlatformSistrix: true }] }
            : { tenantId: pool, usePlatformSistrix: false },
      },
      select: { id: true },
    });
    for (const r of runs) {
      await this.admin.seoSyncRun.update({ where: { id: r.id }, data: { status: 'queued' } });
      await this.addJob(r.id);
    }
    return runs.length;
  }

  private async tenantEligible(tenantId: string): Promise<boolean> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt || !['active', 'trial'].includes(tenant.status)) return false;
    return tenantHasFeature(this.admin, tenantId, 'seo_advanced');
  }

  /** ¿El fondo tiene alguna vía configurada (para no programar en vano)? */
  async poolConfigured(pool: SeoPool): Promise<boolean> {
    if (pool === null) {
      const [mcp, api] = await Promise.all([
        this.connections.find(null, 'sistrix_mcp'),
        this.connections.find(null, 'sistrix_api'),
      ]);
      return (!!mcp && mcp.status !== 'disconnected') || (!!api?.enabled && !!api.apiKeyEncrypted);
    }
    const api = await this.connections.find(pool, 'sistrix_api');
    return !!api?.enabled && !!api.apiKeyEncrypted;
  }

  /**
   * Programador (cada hora): por cada proyecto activo y tipo de dato con
   * frecuencia, si la última tanda terminada es más antigua que su periodo,
   * encola otra. La caché evita repetir lo que ya se pidió para otro proyecto.
   */
  async scheduleDue(now = new Date()): Promise<{ enqueued: number }> {
    const projects = await this.admin.seoProject.findMany({
      where: { status: 'active' },
      select: { id: true, tenantId: true, usePlatformSistrix: true },
    });
    const configured = new Map<string, boolean>();
    let enqueued = 0;
    for (const p of projects) {
      if (p.tenantId && !(await this.tenantEligible(p.tenantId))) continue;
      const pool = poolOfProject(p);
      const key = pool ?? 'platform';
      if (!configured.has(key)) configured.set(key, await this.poolConfigured(pool));
      if (!configured.get(key)) continue;
      const settings = await this.connections.settingsRow(pool);
      const freqs = this.connections.frequenciesOf(settings.frequencies);
      for (const dataType of SEO_SISTRIX_DATA_TYPES) {
        const days = SEO_SYNC_FREQUENCY_DAYS[freqs[dataType]];
        if (days === null) continue;
        const active = await this.activeRun(p.id, dataType);
        if (active) continue;
        const last = await this.admin.seoSyncRun.findFirst({
          where: { projectId: p.id, dataType, status: 'done' },
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true },
        });
        // Un poco de margen: la tarea corre cada hora.
        const due =
          !last?.finishedAt ||
          last.finishedAt.getTime() <= now.getTime() - (days * 24 - 1) * 3600_000;
        if (!due) continue;
        await this.enqueue(p.id, dataType, 'scheduled');
        enqueued++;
      }
    }
    return { enqueued };
  }

  // ------------------------------------------------------------- procesar

  /** Qué hay que pedir en una tanda (troceado al máximo por tanda). */
  async buildItems(
    project: ProjectRow,
    dataType: SeoSistrixDataType,
    maxItems: number,
  ): Promise<RunItem[]> {
    const country = project.country.toLowerCase();
    const own = [...project.domains]
      .sort((a, b) => (a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0))
      .map((d) => d.domain);
    const primary = own[0];
    const competitors = project.competitors.filter((c) => c.isActive).map((c) => c.domain);
    const domains = [...new Set([...own, ...competitors])];
    const items: RunItem[] = [];
    const keywords = async () =>
      this.admin.seoProjectKeyword.findMany({
        where: { projectId: project.id, isActive: true },
        include: { keyword: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        take: project.tenantId ? SEO_TENANT_LIMITS.keywords : SEO_PLATFORM_KEYWORD_LIMIT,
      });
    switch (dataType) {
      case 'visibility':
        for (const domain of domains) {
          const known = await this.admin.seoDomainMetric.count({
            where: { tenantId: poolOfProject(project), domain, country, metric: 'visibility' },
          });
          // La primera vez, medio año de histórico; después, las últimas semanas.
          items.push({
            q: { op: 'visindex', domain, country, history: true, limit: known > 0 ? 4 : 26 },
          });
          items.push({ q: { op: 'kwcount', domain, country } });
        }
        break;
      case 'domain_keywords':
        for (const domain of domains) {
          items.push({
            q: { op: 'domain_keywords', domain, country, limit: SEO_SISTRIX_LIST_LIMIT },
          });
        }
        break;
      case 'competitors':
        if (primary) items.push({ q: { op: 'competitors', domain: primary, country, limit: 10 } });
        for (const domain of competitors) {
          items.push({
            q: { op: 'domain_keywords', domain, country, limit: SEO_SISTRIX_LIST_LIMIT },
          });
        }
        break;
      case 'opportunities':
        if (primary)
          items.push({
            q: { op: 'opportunities', domain: primary, country, limit: SEO_SISTRIX_LIST_LIMIT },
          });
        break;
      case 'keyword_ideas':
        if (primary)
          items.push({
            q: { op: 'ideas', domain: primary, country, limit: SEO_SISTRIX_LIST_LIMIT },
          });
        break;
      case 'backlinks':
        if (primary) items.push({ q: { op: 'linktargets', domain: primary, country, limit: 50 } });
        break;
      case 'ai_visibility':
        for (const domain of [...(primary ? [primary] : []), ...competitors]) {
          items.push({ q: { op: 'ai_overview', domain, country } });
        }
        break;
      case 'serp':
        for (const k of await keywords()) {
          items.push({
            q: {
              op: 'serp',
              keyword: k.keyword.keyword,
              country: k.keyword.country.toLowerCase(),
              limit: 10,
            },
            keywordId: k.keywordId,
          });
        }
        break;
      case 'keyword_metrics':
        for (const k of await keywords()) {
          const c = k.keyword.country.toLowerCase();
          items.push({
            q: { op: 'metrics', keyword: k.keyword.keyword, country: c },
            keywordId: k.keywordId,
          });
          items.push({
            q: { op: 'searchintent', keyword: k.keyword.keyword, country: c },
            keywordId: k.keywordId,
          });
        }
        break;
    }
    return items.slice(0, Math.max(1, maxItems));
  }

  private get pauseDisabled(): boolean {
    return process.env.NODE_ENV === 'test';
  }

  /** Hace (o sigue) una tanda. No lanza: un fallo queda en la tanda. */
  async processRun(runId: string): Promise<void> {
    const run = await this.admin.seoSyncRun.findUnique({ where: { id: runId } });
    if (!run?.dataType || !['queued', 'running'].includes(run.status)) return;
    const project = await this.admin.seoProject.findUnique({
      where: { id: run.projectId },
      include: { domains: true, competitors: true },
    });
    if (!project) return;
    if (project.status !== 'active')
      return this.finish(runId, 'cancelled', 'El proyecto está en pausa.');
    if (project.tenantId && !(await this.tenantEligible(project.tenantId))) {
      return this.finish(runId, 'cancelled', 'El negocio ya no tiene SEO Avanzado.');
    }
    const pool = poolOfProject(project);
    const dataType = run.dataType as SeoSistrixDataType;
    const settings = await this.connections.settingsRow(pool);

    let progress = run.progress as unknown as RunProgress | null;
    if (!progress) {
      progress = { items: await this.buildItems(project, dataType, settings.maxRequestsPerBatch) };
      await this.admin.seoSyncRun.update({
        where: { id: runId },
        data: { progress: progress as unknown as object, itemsTotal: progress.items.length },
      });
    }
    await this.admin.seoSyncRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: {
        status: 'running',
        startedAt: run.startedAt ?? new Date(),
        pausedReason: null,
        pausedUntil: null,
      },
    });

    // Antes de cada tanda por la API, el saldo (gratis): sin créditos no se empieza.
    const route = await this.fetcher.route(pool);
    if (route.provider === 'sistrix_api') {
      const ok = await this.checkCredits(pool);
      if (!ok) return this.wait(runId, 'api_budget', null);
    }

    const ttlBase = SEO_SISTRIX_CACHE_DAYS[dataType];
    const ctxBase = {
      pool,
      projectId: project.id,
      runId,
      userId: run.createdByUserId,
      superAdminId: run.createdBySuperAdminId,
      ttlDays: ttlBase,
      maxAgeMs: run.kind === 'manual' ? SEO_SISTRIX_MANUAL_CACHE_HOURS * 3600_000 : null,
      maxPerDay: settings.maxRequestsPerDay,
    };
    let lastError: string | null = run.error;
    for (let i = 0; i < progress.items.length; i++) {
      const item = progress.items[i]!;
      if (item.status) continue;
      if (await this.stopped(runId)) return;
      let res: FetchResult;
      try {
        res = await this.fetcher.fetch(ctxBase, item.q);
      } catch (err) {
        res = { kind: 'error', code: null, message: (err as Error).message, provider: null };
      }
      if (res.kind === 'wait') return this.wait(runId, res.reason, res.until);
      let credits = 0;
      let provider: SeoProviderKey | null = null;
      if (res.kind === 'error') {
        item.status = 'failed';
        lastError = res.message;
      } else {
        try {
          await this.store(project, pool, item, res);
          item.status = 'done';
          credits = res.credits;
          provider = res.provider;
        } catch (err) {
          item.status = 'failed';
          lastError = `No se pudo guardar: ${(err as Error).message}`;
          this.logger.warn(`SISTRIX ${runId}: ${lastError}`);
        }
      }
      await this.admin.seoSyncRun.update({
        where: { id: runId },
        data: {
          progress: progress as unknown as object,
          ...(item.status === 'done'
            ? { itemsDone: { increment: 1 } }
            : { itemsFailed: { increment: 1 } }),
          creditsUsed: { increment: credits },
          error: lastError,
          ...(provider ? { provider } : {}),
        },
      });
      const fromCache = res.kind === 'data' && res.fromCache;
      if (
        !fromCache &&
        !this.pauseDisabled &&
        settings.pauseMs > 0 &&
        i < progress.items.length - 1
      ) {
        await new Promise((r) => setTimeout(r, settings.pauseMs));
      }
    }
    const final = await this.admin.seoSyncRun.findUnique({ where: { id: runId } });
    if (!final) return;
    const allFailed = final.itemsTotal > 0 && final.itemsFailed === final.itemsTotal;
    await this.finish(
      runId,
      allFailed ? 'failed' : 'done',
      final.itemsFailed > 0 ? lastError : null,
    );
    // Los datos que usa el motor de oportunidades: se recalcula aparte.
    if (!allFailed && OPPORTUNITY_DATA_TYPES.includes(dataType)) {
      await this.opportunities.schedule(project.id);
    }
  }

  /** Saldo de la API (gratis) antes de una tanda; corta si no quedan créditos. */
  async checkCredits(pool: SeoPool): Promise<boolean> {
    const conn = await this.connections.find(pool, 'sistrix_api');
    const key = this.connections.apiKeyOf(conn);
    if (!conn || !key) return false;
    try {
      const balance = await this.api.credits(key);
      await this.connections.update(conn.id, {
        creditsBalance: balance,
        creditsCheckedAt: new Date(),
      });
      return balance === null || balance > 0;
    } catch (err) {
      await this.connections.update(conn.id, {
        lastError: (err as Error).message,
        lastErrorAt: new Date(),
      });
      return !(err instanceof SistrixDataError);
    }
  }

  private async stopped(runId: string): Promise<boolean> {
    const r = await this.admin.seoSyncRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return !r || r.status !== 'running';
  }

  private async wait(
    runId: string,
    reason: SeoSistrixWaitReason,
    until: Date | null,
  ): Promise<void> {
    await this.admin.seoSyncRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { status: 'waiting', pausedReason: reason, pausedUntil: until },
    });
  }

  private async finish(
    runId: string,
    status: 'done' | 'failed' | 'cancelled',
    error: string | null,
  ) {
    await this.admin.seoSyncRun.updateMany({
      where: { id: runId, status: { in: ACTIVE } },
      data: { status, error, finishedAt: new Date(), pausedReason: null, pausedUntil: null },
    });
  }

  // ------------------------------------------------------------- guardar

  /**
   * Guarda lo descargado. Las tablas del fondo (por dominio o palabra) se
   * escriben sin duplicar (`skipDuplicates` con su clave única); lo del
   * proyecto (competidores descubiertos), siempre. Las métricas de una palabra
   * son histórico: lo servido de la caché no añade otra observación.
   */
  async store(
    project: ProjectRow,
    pool: SeoPool,
    item: RunItem,
    res: Extract<FetchResult, { kind: 'data' }>,
  ): Promise<void> {
    if (!res.data) return;
    const data: SistrixData = res.data;
    const q = item.q;
    const country = q.country.toLowerCase();
    const provider = res.provider;
    const fetchedAt = res.fetchedAt;
    const sampleDate = day(madridToday(fetchedAt));
    switch (data.op) {
      case 'visindex':
      case 'kwcount':
        await this.admin.seoDomainMetric.createMany({
          data: data.points.map((p) => ({
            tenantId: pool,
            domain: (p.domain ?? q.domain ?? '').toLowerCase(),
            country,
            provider,
            metric: data.op === 'visindex' ? 'visibility' : 'keyword_count',
            granularity: 'weekly',
            metricDate: day(p.date),
            value: p.value,
            fetchedAt,
          })),
          skipDuplicates: true,
        });
        return;
      case 'competitors': {
        const own = new Set(project.domains.map((d) => d.domain));
        const fresh = data.domains.filter((d) => !own.has(d));
        if (fresh.length === 0) return;
        await this.admin.seoCompetitor.createMany({
          data: fresh.map((domain) => ({
            tenantId: project.tenantId,
            projectId: project.id,
            domain,
            source: 'discovered',
            isActive: false,
          })),
          skipDuplicates: true,
        });
        return;
      }
      case 'domain_keywords':
        await this.admin.seoDomainKeyword.createMany({
          data: data.rows
            .filter((r) => r.position !== null)
            .map((r) => ({
              tenantId: pool,
              domain: q.domain ?? '',
              country,
              provider,
              sampleDate,
              fetchedAt,
              keyword: r.keyword,
              position: r.position!,
              url: r.url ?? '',
            })),
          skipDuplicates: true,
        });
        return;
      case 'opportunities':
      case 'ideas':
        await this.admin.seoDomainOpportunity.createMany({
          data: data.rows.map((r) => ({
            tenantId: pool,
            domain: q.domain ?? '',
            country,
            provider,
            kind: data.op === 'ideas' ? 'idea' : 'opportunity',
            sampleDate,
            fetchedAt,
            keyword: r.keyword,
            position: r.position,
            url: r.url,
            gain: r.gain,
            competition: r.competition,
            traffic: r.traffic,
          })),
          skipDuplicates: true,
        });
        return;
      case 'serp':
        if (!item.keywordId) return;
        await this.admin.seoSerpResult.createMany({
          data: data.rows.map((r) => ({
            tenantId: pool,
            keywordId: item.keywordId!,
            country,
            provider,
            sampleDate,
            fetchedAt,
            position: r.position,
            domain: r.domain,
            url: r.url,
          })),
          skipDuplicates: true,
        });
        return;
      case 'metrics':
      case 'searchintent': {
        if (!item.keywordId || res.fromCache) return;
        const fields =
          data.op === 'metrics'
            ? data.metrics && {
                traffic: data.metrics.traffic,
                clicks: data.metrics.clicks,
                cpc: data.metrics.cpc,
                competition: data.metrics.competition,
                mobileShare: data.metrics.mobileShare,
                desktopShare: data.metrics.desktopShare,
              }
            : data.intent && {
                intentKnow: data.intent.know,
                intentDo: data.intent.do,
                intentVisit: data.intent.visit,
                intentWebsite: data.intent.website,
              };
        if (!fields) return;
        // Una observación por día: las dos consultas del mismo día van en la misma fila.
        const sameDay = await this.admin.seoKeywordMetric.findFirst({
          where: {
            tenantId: pool,
            keywordId: item.keywordId,
            country,
            provider,
            dataDate: sampleDate,
          },
          select: { id: true },
        });
        if (sameDay) {
          await this.admin.seoKeywordMetric.update({ where: { id: sameDay.id }, data: fields });
        } else {
          await this.admin.seoKeywordMetric.create({
            data: {
              tenantId: pool,
              keywordId: item.keywordId,
              country,
              provider,
              fetchedAt,
              dataDate: sampleDate,
              ...fields,
            },
          });
        }
        return;
      }
      case 'linktargets':
        await this.admin.seoBacklinkTarget.createMany({
          data: data.rows.map((r) => ({
            tenantId: pool,
            domain: q.domain ?? '',
            provider,
            sampleDate,
            fetchedAt,
            url: r.url,
            links: r.links,
            domains: r.domains,
            hosts: r.hosts,
          })),
          skipDuplicates: true,
        });
        return;
      case 'ai_overview':
        if (!data.overview) return;
        await this.admin.seoAiVisibility.createMany({
          data: [
            {
              tenantId: pool,
              domain: q.domain ?? '',
              country,
              provider,
              sampleDate,
              fetchedAt,
              promptCount: data.overview.promptCount,
              models: data.overview.models as unknown as object,
            },
          ],
          skipDuplicates: true,
        });
        return;
    }
  }

  // ------------------------------------------------------------ limpieza

  /** Registro de peticiones (90 días por defecto) y respuestas caducadas de la caché. */
  async cleanup(now = new Date()): Promise<{ requests: number; cache: number }> {
    const days = this.config.get('RETENTION_SEO_API_REQUESTS_DAYS', { infer: true });
    const [requests, cache] = await Promise.all([
      this.admin.seoApiRequest.deleteMany({
        where: { createdAt: { lt: new Date(now.getTime() - days * 24 * 3600_000) } },
      }),
      this.admin.seoApiCache.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);
    return { requests: requests.count, cache: cache.count };
  }

  /** Catálogo de herramientas del MCP (cada día). */
  async dailyTools(): Promise<void> {
    const mcp = await this.connections.find(null, 'sistrix_mcp');
    if (mcp?.status !== 'connected') return;
    await this.mcp.syncTools().catch((err: unknown) => {
      this.logger.warn(`tools/list diario: ${(err as Error).message}`);
    });
  }
}
