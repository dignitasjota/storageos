import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SEO_AI_COUNTRY,
  SEO_AI_PROMPTS_LIMIT,
  SEO_AI_SOURCES_LIMIT,
  SEO_PLATFORM_KEYWORD_LIMIT,
  SEO_SISTRIX_CACHE_DAYS,
  SEO_SISTRIX_DATA_TYPES,
  SEO_SISTRIX_LIST_LIMIT,
  SEO_SISTRIX_MANUAL_CACHE_HOURS,
  SEO_SYNC_FREQUENCY_DAYS,
  SEO_TENANT_LIMITS,
  madridToday,
  seoAiBrandSubject,
  seoAiPromptKey,
  seoAiVisibilitySettingsOf,
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
  /** Todo lo que habría que pedir (los elementos de esta tanda son un trozo). */
  total?: number;
  /**
   * Lo que falta por consultar en la vuelta en curso tras esta tanda (la siguiente
   * continúa por ahí; 0 = la vuelta está completa).
   */
  remaining?: number;
  /** Por dónde sigue la rotación. */
  nextOffset?: number;
}

export interface SistrixActor {
  userId?: string | null;
  superAdminId?: string | null;
}

export const sistrixJobId = (runId: string) => `seo-sistrix-${runId}`;

/**
 * A quién se refiere una consulta de `ai_check`: un dominio o, sin él, las
 * marcas del proyecto (juntas, con la misma clave que se lee después).
 */
export function aiSubject(q: SistrixQuery): { subjectType: 'domain' | 'brand'; subject: string } {
  if (q.domain) return { subjectType: 'domain', subject: q.domain.toLowerCase() };
  return { subjectType: 'brand', subject: seoAiBrandSubject(q.brands ?? []) ?? '' };
}

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

/**
 * ¿Puede el fondo pedir ese tipo de dato? La visibilidad en IA (`ai_check`) solo
 * existe en el MCP, y un tenant con su clave solo tiene la API clásica.
 */
export function sistrixPoolCanServe(pool: SeoPool, dataType: SeoSistrixDataType): boolean {
  return dataType !== 'ai_visibility' || pool === null;
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
        if (!sistrixPoolCanServe(pool, dataType)) continue;
        const active = await this.activeRun(p.id, dataType);
        if (active) continue;
        const recent = await this.admin.seoSyncRun.findMany({
          where: { projectId: p.id, dataType, status: { in: ['done', 'failed'] } },
          orderBy: { finishedAt: 'desc' },
          take: 6,
          select: { status: true, finishedAt: true, progress: true },
        });
        const last = recent.find((r) => r.status === 'done');
        // Tandas fallidas seguidas: la espera crece (3 h, 6 h, 12 h…) hasta el
        // periodo; no se vuelve a pedir cada hora a una clave mala o a SISTRIX caído.
        const failures = recent.findIndex((r) => r.status === 'done');
        const failedInARow = failures === -1 ? recent.length : failures;
        if (failedInARow > 0) {
          const backoffH = Math.min(days * 24, 3 * 2 ** (failedInARow - 1));
          const at = recent[0]?.finishedAt;
          if (at && at.getTime() > now.getTime() - backoffH * 3600_000) continue;
        }
        // Un poco de margen: la tarea corre cada hora.
        const periodDue =
          !last?.finishedAt ||
          last.finishedAt.getTime() <= now.getTime() - (days * 24 - 1) * 3600_000;
        // Si la última tanda no cubrió todo (el máximo por tanda), la siguiente
        // continúa sin esperar al periodo.
        const unfinished = ((last?.progress as unknown as RunProgress | null)?.remaining ?? 0) > 0;
        if (!periodDue && !unfinished) continue;
        await this.enqueue(p.id, dataType, 'scheduled');
        enqueued++;
      }
    }
    return { enqueued };
  }

  // ------------------------------------------------------------- procesar

  /** Qué hay que pedir en una tanda (el trozo que toca, al máximo por tanda). */
  async buildItems(
    project: ProjectRow,
    dataType: SeoSistrixDataType,
    maxItems: number,
    offset = 0,
  ): Promise<RunItem[]> {
    return (await this.planItems(project, dataType, maxItems, offset)).items;
  }

  /**
   * Todo lo que habría que pedir (en grupos que no se parten: las dos consultas
   * de una palabra o de un dominio van juntas) y el trozo que cabe en esta
   * tanda. Las palabras empiezan por las que llevan más tiempo sin consulta (o
   * sin ella); el resto sigue rotando desde donde acabó la tanda anterior: así
   * la siguiente tanda continúa y no repite siempre las mismas.
   */
  async planItems(
    project: ProjectRow,
    dataType: SeoSistrixDataType,
    maxItems: number,
    offset = 0,
  ): Promise<{ items: RunItem[]; total: number; remaining: number; nextOffset: number }> {
    const { groups, rotates } = await this.itemGroups(project, dataType);
    const total = groups.reduce((n, g) => n + g.length, 0);
    const start = rotates && groups.length > 0 ? offset % groups.length : 0;
    const items: RunItem[] = [];
    let taken = 0;
    for (let k = 0; k < groups.length; k++) {
      const g = groups[(start + k) % groups.length]!;
      if (items.length > 0 && items.length + g.length > Math.max(1, maxItems)) break;
      items.push(...g);
      taken++;
    }
    return {
      items,
      total,
      remaining: Math.max(0, total - items.length),
      nextOffset: rotates && groups.length > 0 ? (start + taken) % groups.length : 0,
    };
  }

  private async itemGroups(
    project: ProjectRow,
    dataType: SeoSistrixDataType,
  ): Promise<{ groups: RunItem[][]; rotates: boolean }> {
    const country = project.country.toLowerCase();
    const own = [...project.domains]
      .sort((a, b) => (a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0))
      .map((d) => d.domain);
    const primary = own[0];
    const competitors = project.competitors.filter((c) => c.isActive).map((c) => c.domain);
    const domains = [...new Set([...own, ...competitors])];
    const groups: RunItem[][] = [];
    const keywords = async () => {
      const rows = await this.admin.seoProjectKeyword.findMany({
        where: { projectId: project.id, isActive: true },
        include: { keyword: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        take: project.tenantId ? SEO_TENANT_LIMITS.keywords : SEO_PLATFORM_KEYWORD_LIMIT,
      });
      // Primero las que llevan más tiempo sin consulta o nunca la tuvieron.
      const last = await this.lastQueried(
        project,
        dataType,
        rows.map((r) => r.keywordId),
      );
      return rows
        .map((r, i) => ({ r, i, at: last.get(r.keywordId) ?? 0 }))
        .sort((a, b) => a.at - b.at || a.i - b.i)
        .map((x) => x.r);
    };
    let rotates = true;
    switch (dataType) {
      case 'visibility':
        for (const domain of domains) {
          const known = await this.admin.seoDomainMetric.count({
            where: { tenantId: poolOfProject(project), domain, country, metric: 'visibility' },
          });
          // La primera vez, medio año de histórico; después, las últimas semanas.
          groups.push([
            { q: { op: 'visindex', domain, country, history: true, limit: known > 0 ? 4 : 26 } },
            { q: { op: 'kwcount', domain, country } },
          ]);
        }
        break;
      case 'domain_keywords':
        for (const domain of domains) {
          groups.push([
            { q: { op: 'domain_keywords', domain, country, limit: SEO_SISTRIX_LIST_LIMIT } },
          ]);
        }
        break;
      case 'competitors':
        if (primary)
          groups.push([{ q: { op: 'competitors', domain: primary, country, limit: 10 } }]);
        for (const domain of competitors) {
          groups.push([
            { q: { op: 'domain_keywords', domain, country, limit: SEO_SISTRIX_LIST_LIMIT } },
          ]);
        }
        break;
      case 'opportunities':
        if (primary)
          groups.push([
            { q: { op: 'opportunities', domain: primary, country, limit: SEO_SISTRIX_LIST_LIMIT } },
          ]);
        break;
      case 'keyword_ideas':
        if (primary)
          groups.push([
            { q: { op: 'ideas', domain: primary, country, limit: SEO_SISTRIX_LIST_LIMIT } },
          ]);
        break;
      case 'backlinks':
        if (primary)
          groups.push([{ q: { op: 'linktargets', domain: primary, country, limit: 50 } }]);
        break;
      case 'ai_visibility': {
        // `ai_check` (PR 12), siempre en España: resumen y prompts de tu dominio,
        // de tu marca y de cada competidor; fuentes citadas y marcas que
        // compiten de lo tuyo, y las respuestas de los prompts que sigues.
        const c = SEO_AI_COUNTRY;
        const brands = project.brandTerms.length ? [...project.brandTerms] : null;
        const subjects: { domain?: string; brands?: string[] }[] = [
          ...(primary ? [{ domain: primary }] : []),
          ...(brands ? [{ brands }] : []),
          ...competitors.map((domain) => ({ domain })),
        ];
        for (const sub of subjects) groups.push([{ q: { op: 'ai_overview', country: c, ...sub } }]);
        for (const sub of subjects) {
          groups.push([
            { q: { op: 'ai_prompts', country: c, limit: SEO_AI_PROMPTS_LIMIT, ...sub } },
          ]);
        }
        const mine = {
          ...(primary ? { domain: primary } : {}),
          ...(brands ? { brands } : {}),
        };
        if (primary || brands) {
          groups.push([
            {
              q: {
                op: 'ai_sources',
                country: c,
                sourceType: 'url',
                limit: SEO_AI_SOURCES_LIMIT,
                ...mine,
              },
            },
          ]);
          groups.push([{ q: { op: 'ai_competitors', country: c, limit: 20, ...mine } }]);
        }
        for (const prompt of seoAiVisibilitySettingsOf(project.aiVisibilitySettings)
          .trackedPrompts) {
          groups.push([{ q: { op: 'ai_answers', country: c, prompt, limit: 10 } }]);
        }
        break;
      }
      case 'serp':
        rotates = false;
        for (const k of await keywords()) {
          groups.push([
            {
              q: {
                op: 'serp',
                keyword: k.keyword.keyword,
                country: k.keyword.country.toLowerCase(),
                limit: 10,
              },
              keywordId: k.keywordId,
            },
          ]);
        }
        break;
      case 'keyword_metrics':
        rotates = false;
        for (const k of await keywords()) {
          const c = k.keyword.country.toLowerCase();
          groups.push([
            {
              q: { op: 'metrics', keyword: k.keyword.keyword, country: c },
              keywordId: k.keywordId,
            },
            {
              q: { op: 'searchintent', keyword: k.keyword.keyword, country: c },
              keywordId: k.keywordId,
            },
          ]);
        }
        break;
    }
    return { groups, rotates };
  }

  /** Cuándo se consultó por última vez cada palabra (ms; nunca = sin entrada). */
  private async lastQueried(
    project: ProjectRow,
    dataType: SeoSistrixDataType,
    keywordIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (keywordIds.length === 0) return out;
    const tenantId = poolOfProject(project);
    if (dataType === 'serp') {
      const rows = await this.admin.seoSerpResult.groupBy({
        by: ['keywordId'],
        where: { tenantId, keywordId: { in: keywordIds } },
        _max: { fetchedAt: true },
      });
      for (const r of rows) if (r._max.fetchedAt) out.set(r.keywordId, r._max.fetchedAt.getTime());
    } else {
      const rows = await this.admin.seoKeywordMetric.groupBy({
        by: ['keywordId'],
        where: { tenantId, keywordId: { in: keywordIds } },
        _max: { fetchedAt: true },
      });
      for (const r of rows) if (r._max.fetchedAt) out.set(r.keywordId, r._max.fetchedAt.getTime());
    }
    return out;
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

    // Lo que no puede servir el fondo (la visibilidad en IA solo existe en el MCP
    // de la plataforma) no se queda esperando para siempre: se cierra con su motivo.
    if (!sistrixPoolCanServe(pool, dataType)) {
      return this.finish(
        runId,
        'cancelled',
        'Este dato solo se puede pedir con la conexión de SISTRIX de la plataforma.',
      );
    }

    let progress = run.progress as unknown as RunProgress | null;
    if (!progress) {
      // Continúa por donde acabó la tanda anterior de este tipo.
      const prev = await this.admin.seoSyncRun.findFirst({
        where: { projectId: project.id, dataType, status: 'done', id: { not: runId } },
        orderBy: { finishedAt: 'desc' },
        select: { progress: true },
      });
      const prevProgress = prev?.progress as unknown as RunProgress | null;
      const plan = await this.planItems(
        project,
        dataType,
        settings.maxRequestsPerBatch,
        prevProgress?.nextOffset ?? 0,
      );
      // Una vuelta puede tardar varias tandas: lo que falta es lo de la anterior
      // menos lo que cabe en esta (o, al empezar vuelta, lo que no cabe).
      const left =
        (prevProgress?.remaining ?? 0) > 0
          ? Math.max(0, prevProgress!.remaining! - plan.items.length)
          : plan.remaining;
      progress = {
        items: plan.items,
        total: plan.total,
        remaining: left,
        nextOffset: plan.nextOffset,
      };
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
      if (ok === 'invalid_key') {
        // Una clave mala no se reintenta cada hora: la tanda cae con el motivo y
        // el programador no vuelve a lanzarla hasta que haya otra clave.
        return this.finish(
          runId,
          'failed',
          'SISTRIX no acepta la clave de API. Revísala en la configuración de SISTRIX.',
        );
      }
      if (ok === 'no_credits') return this.wait(runId, 'api_budget', null);
    }

    const ttlBase = SEO_SISTRIX_CACHE_DAYS[dataType];
    // Las programadas no reutilizan una respuesta tan vieja como el periodo de su
    // frecuencia: poner «cada día» tiene que traer datos nuevos cada día.
    const freqDays =
      SEO_SYNC_FREQUENCY_DAYS[this.connections.frequenciesOf(settings.frequencies)[dataType]];
    const scheduledMaxAgeMs = freqDays ? Math.max(1, freqDays * 24 - 3) * 3600_000 : null;
    const ctxBase = {
      pool,
      projectId: project.id,
      runId,
      userId: run.createdByUserId,
      superAdminId: run.createdBySuperAdminId,
      ttlDays: ttlBase,
      maxAgeMs:
        run.kind === 'manual' ? SEO_SISTRIX_MANUAL_CACHE_HOURS * 3600_000 : scheduledMaxAgeMs,
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
      if (res.kind === 'wait') {
        // Lo que esta vía no puede servir no espera en bucle: se cierra.
        if (res.reason === 'not_supported' && res.until === null) {
          return this.finish(
            runId,
            'cancelled',
            'Este dato no se puede pedir por la vía de SISTRIX que tienes conectada.',
          );
        }
        return this.wait(runId, res.reason, res.until);
      }
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
          // Una respuesta de la caché no cambia por quién se sirvió la tanda.
          provider = res.fromCache ? null : res.provider;
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

  /**
   * Saldo de la API (gratis) antes de una tanda: `ok`, `no_credits` (se espera) o
   * `invalid_key` (SISTRIX no acepta la clave: no se reintenta cada hora).
   */
  async checkCredits(pool: SeoPool): Promise<'ok' | 'no_credits' | 'invalid_key'> {
    const conn = await this.connections.find(pool, 'sistrix_api');
    const key = this.connections.apiKeyOf(conn);
    if (!conn || !key) return 'no_credits';
    try {
      const balance = await this.api.credits(key);
      await this.connections.update(conn.id, {
        creditsBalance: balance,
        creditsCheckedAt: new Date(),
        lastError: null,
      });
      return balance === null || balance > 0 ? 'ok' : 'no_credits';
    } catch (err) {
      await this.connections.update(conn.id, {
        lastError: (err as Error).message,
        lastErrorAt: new Date(),
      });
      return err instanceof SistrixDataError ? 'invalid_key' : 'ok';
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
              subjectType: aiSubject(q).subjectType,
              domain: aiSubject(q).subject,
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
      case 'ai_prompts':
      case 'ai_answers': {
        const tracked = data.op === 'ai_answers';
        const subject = tracked ? { subjectType: 'tracked', subject: '' } : aiSubject(q);
        await this.admin.seoAiPrompt.createMany({
          data: data.prompts.map((r) => {
            const prompt = tracked ? (q.prompt ?? r.prompt) : r.prompt;
            return {
              tenantId: pool,
              ...subject,
              country,
              provider,
              sampleDate,
              fetchedAt,
              prompt,
              promptKey: seoAiPromptKey(prompt),
              model: r.model,
              answer: r.answer,
              rank: r.rank,
            };
          }),
          skipDuplicates: true,
        });
        return;
      }
      case 'ai_sources':
      case 'ai_competitors': {
        const subject = aiSubject(q);
        await this.admin.seoAiSource.createMany({
          data: data.sources.map((r) => ({
            tenantId: pool,
            ...subject,
            country,
            provider,
            sampleDate,
            fetchedAt,
            sourceType: data.op === 'ai_competitors' ? 'brand' : (q.sourceType ?? 'url'),
            source: r.source,
            count: r.count,
          })),
          skipDuplicates: true,
        });
        return;
      }
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
