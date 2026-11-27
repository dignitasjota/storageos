import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  SEO_INDEX_CATEGORY_ACTIONS,
  SEO_INSPECTION_GOOGLE_DAILY_LIMIT,
  SEO_INSPECTION_LIST_MAX,
  normalizeSeoUrl,
  seoAbsoluteUrl,
  seoCanonicalMismatch,
  seoInspectionIndexed,
  seoInspectionQuota,
  seoInspectionUrlKey,
  seoNextQuotaReset,
  seoNotIndexedReason,
  seoQuotaDay,
  seoTechnicalSettingsOf,
  selectSeoInspectionBatch,
  splitSeoUrl,
  type SeoInspectResultDto,
  type SeoInspectionHistoryDto,
  type SeoInspectionQuotaDto,
  type SeoInspectionReason,
  type SeoInspectionsDto,
  type SeoTechnicalSettings,
  type SeoTechnicalTrigger,
  type UpdateSeoTechnicalSettingsInput,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { GoogleApiError } from '../../../common/google/google-service-account';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { JOB_SEO_INSPECTIONS, QUEUE_SEO } from '../../queues/queue-names';
import { SearchConsoleClient } from '../../search-console/search-console.client';
import { seoProjectEligible } from '../reports/seo-eligible';
import {
  SeoProjectsService,
  type ProjectRow,
  type SeoActor,
  type SeoOwner,
} from '../seo-projects.service';

import {
  SeoTechnicalReadService,
  inspectionDto,
  type InspectionRow,
} from './seo-technical-read.service';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
/** Pausa entre dos inspecciones de la cola (Google deja 600 al minuto por propiedad). */
const PAUSE_MS = process.env.NODE_ENV === 'test' ? 0 : 1000;
/** Inspecciones como mucho en cada pasada de la cola. */
const QUEUE_BATCH = 500;
/** Días de Search Console que se miran para «las páginas con más clics». */
const TOP_PAGES_DAYS = 28;
/** Una fila en curso desde hace más de esto se da por perdida y vuelve a la cola. */
const STUCK_MS = 15 * 60_000;

type Domain = ProjectRow['domains'][number];

/** Dónde se inspecciona una URL: la URL exacta para Google y su propiedad. */
interface Target {
  url: string;
  urlKey: string;
  domain: Domain;
}

/** Host de una propiedad (`sc-domain:x` o `https://www.x/`), sin `www.`. */
function propertyHost(property: string): string {
  return property.startsWith('sc-domain:')
    ? property
        .slice('sc-domain:'.length)
        .toLowerCase()
        .replace(/^www\./, '')
    : splitSeoUrl(property).host;
}

/** La URL tal como la acepta la propiedad (en las de prefijo, con su protocolo y su `www`). */
function urlForProperty(url: string, property: string): string | null {
  if (property.startsWith('sc-domain:')) return url;
  const prefix = property.endsWith('/') ? property : `${property}/`;
  const rest = url.replace(/^https?:\/\/[^/?#]+/i, '') || '/';
  const rebuilt = `${prefix.replace(/^(https?:\/\/[^/]+).*$/i, '$1')}${rest.startsWith('/') ? rest : `/${rest}`}`;
  return rebuilt.toLowerCase().startsWith(prefix.toLowerCase()) ? rebuilt : null;
}

/**
 * Inspección de URL de Google (PR 9): bajo demanda o en lote, con la cuota
 * de Google (2.000 al día por propiedad) y el tope propio del proyecto. La
 * cuota se cuenta por día del Pacífico; lo que no cabe espera al día
 * siguiente. Cada inspección es una fila (histórico) y la última de cada URL
 * alimenta la Indexación (hallazgos «canónica distinta» y «URL objetivo no
 * indexada», con su ciclo de vida), las palabras seguidas, las oportunidades
 * y las alertas.
 */
@Injectable()
export class SeoInspectionService {
  private readonly logger = new Logger(SeoInspectionService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly client: SearchConsoleClient,
    private readonly read: SeoTechnicalReadService,
    private readonly notifications: NotificationsService,
    @InjectQueue(QUEUE_SEO) private readonly queue: Queue,
  ) {}

  /** Pausa entre llamadas (se puede bajar en las pruebas). */
  pauseMs = PAUSE_MS;

  settingsOf(project: {
    tenantId: string | null;
    technicalSettings: unknown;
  }): SeoTechnicalSettings {
    return seoTechnicalSettingsOf(
      project.technicalSettings,
      project.tenantId ? 'tenant' : 'platform',
    );
  }

  // ------------------------------------------------------------- ajustes

  async updateSettings(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoTechnicalSettingsInput,
  ): Promise<SeoTechnicalSettings> {
    const project = await this.projects.resolveProject(owner, projectId);
    const scope = project.tenantId ? 'tenant' : 'platform';
    const { reset, ...rest } = input;
    const current = reset ? seoTechnicalSettingsOf(null, scope) : this.settingsOf(project);
    const clean = seoTechnicalSettingsOf({ ...current, ...rest }, scope);
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { technicalSettings: clean as unknown as Prisma.InputJsonValue },
    });
    return clean;
  }

  // ---------------------------------------------------------------- cuota

  async quota(project: ProjectRow, now = new Date()): Promise<SeoInspectionQuotaDto> {
    const day = seoQuotaDay(now);
    const settings = this.settingsOf(project);
    const properties = [...new Set(project.domains.map((d) => d.gscProperty))];
    const [used, byProperty, queued, waiting] = await Promise.all([
      this.admin.seoUrlInspection.count({
        where: { projectId: project.id, quotaDay: new Date(`${day}T00:00:00Z`) },
      }),
      properties.length
        ? this.admin.seoUrlInspection.groupBy({
            by: ['gscProperty'],
            where: { gscProperty: { in: properties }, quotaDay: new Date(`${day}T00:00:00Z`) },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      this.admin.seoUrlInspection.count({
        where: {
          projectId: project.id,
          status: { in: ['queued', 'running'] },
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: seoNextQuotaReset(now) } }],
        },
      }),
      this.admin.seoUrlInspection.count({
        where: {
          projectId: project.id,
          status: 'queued',
          scheduledFor: { gte: seoNextQuotaReset(now) },
        },
      }),
    ]);
    const propertyUsed = Math.max(0, ...byProperty.map((r) => r._count._all));
    return {
      ...seoInspectionQuota({
        usedByProject: used,
        usedByProperty: propertyUsed,
        cap: settings.inspectionDailyCap,
      }),
      day,
      googleLimit: SEO_INSPECTION_GOOGLE_DAILY_LIMIT,
      resetsAt: seoNextQuotaReset(now).toISOString(),
      queued: Math.max(0, queued - waiting),
      waitingNextDay: waiting,
    };
  }

  // -------------------------------------------------------------- lectura

  async list(owner: SeoOwner | undefined, projectId: string): Promise<SeoInspectionsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    // La última fila de cada URL (también la que espera).
    const ids = await this.admin.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id::text AS id FROM (
        SELECT DISTINCT ON (url_key) id, created_at FROM seo_url_inspections
        WHERE project_id = ${projectId}::uuid
        ORDER BY url_key, created_at DESC
      ) t ORDER BY created_at DESC LIMIT ${SEO_INSPECTION_LIST_MAX}`);
    const rows = ids.length
      ? await this.admin.seoUrlInspection.findMany({
          where: { id: { in: ids.map((r) => r.id) } },
          orderBy: [{ createdAt: 'desc' }],
        })
      : [];
    const latest = await this.read.latestInspections(projectId);
    let indexed = 0;
    let notIndexed = 0;
    let mismatch = 0;
    for (const r of latest.values()) {
      if (r.indexed === true) indexed++;
      if (r.indexed === false) notIndexed++;
      if (r.canonicalMismatch) mismatch++;
    }
    return {
      quota: await this.quota(project),
      settings: this.settingsOf(project),
      items: rows.map(inspectionDto),
      summary: { urls: latest.size, indexed, notIndexed, canonicalMismatch: mismatch },
    };
  }

  async history(
    owner: SeoOwner | undefined,
    projectId: string,
    rawUrl: string,
  ): Promise<SeoInspectionHistoryDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
    const key = seoInspectionUrlKey(rawUrl, primary?.domain ?? '');
    const rows = await this.admin.seoUrlInspection.findMany({
      where: { projectId, urlKey: key },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    return {
      url: rows[0]?.url ?? seoAbsoluteUrl(rawUrl, primary?.domain ?? ''),
      items: rows.map(inspectionDto),
    };
  }

  // ------------------------------------------------------ bajo demanda

  /** La URL para Google y el dominio del proyecto al que pertenece (400 si no es suyo). */
  resolveTarget(project: ProjectRow, rawUrl: string): Target {
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
    if (!primary) {
      throw new BadRequestException({
        code: 'seo_no_domain',
        message: 'El proyecto no tiene ningún dominio con Search Console.',
      });
    }
    const absolute = seoAbsoluteUrl(rawUrl, primary.domain);
    const host = splitSeoUrl(absolute).host;
    const candidates = [...project.domains].sort(
      (a, b) =>
        Number(splitSeoUrl(`https://${b.domain}`).host === host) -
        Number(splitSeoUrl(`https://${a.domain}`).host === host),
    );
    for (const d of candidates) {
      const ph = propertyHost(d.gscProperty);
      const covered =
        host === ph || (d.gscProperty.startsWith('sc-domain:') && host.endsWith(`.${ph}`));
      if (!covered) continue;
      const url = urlForProperty(absolute, d.gscProperty);
      if (!url) continue;
      return { url, urlKey: normalizeSeoUrl(url), domain: d };
    }
    throw new BadRequestException({
      code: 'url_not_in_project',
      message: 'Esa URL no es de ningún dominio del proyecto con Search Console.',
    });
  }

  /**
   * Inspeccionar una URL ahora. Si no queda cuota hoy, la petición espera al
   * día siguiente (se avisa en la respuesta). Si ya espera en la cola, se
   * devuelve esa.
   */
  async inspect(
    owner: SeoOwner,
    projectId: string,
    rawUrl: string,
    actor: SeoActor = {},
  ): Promise<SeoInspectResultDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const target = this.resolveTarget(project, rawUrl);
    let pending = await this.admin.seoUrlInspection.findFirst({
      where: { projectId, urlKey: target.urlKey, status: { in: ['queued', 'running'] } },
    });
    // Una «en curso» de hace más de 15 minutos (el API se reinició durante la llamada
    // a Google) se vuelve a hacer: no se queda «ya se está inspeccionando» para siempre.
    if (pending?.status === 'running' && pending.updatedAt.getTime() < Date.now() - 15 * 60_000) {
      pending = await this.admin.seoUrlInspection.update({
        where: { id: pending.id },
        data: { status: 'queued' },
      });
    }
    const row =
      pending ??
      (await this.admin.seoUrlInspection.create({
        data: {
          tenantId: project.tenantId,
          projectId,
          domainId: target.domain.id,
          domain: target.domain.domain,
          gscProperty: target.domain.gscProperty,
          url: target.url,
          urlKey: target.urlKey,
          trigger: 'manual',
          reason: 'manual',
          requestedByUserId: actor.userId ?? null,
          requestedBySuperAdminId: actor.superAdminId ?? null,
        },
      }));
    const outcome = pending && pending.status === 'running' ? 'running' : await this.runOne(row.id);
    const done = await this.admin.seoUrlInspection.findUniqueOrThrow({ where: { id: row.id } });
    const dto = inspectionDto(done);
    if (outcome === 'deferred') {
      await this.notifyQuota(project);
      return {
        inspection: dto,
        deferred: true,
        message: `No queda cuota de inspecciones hoy. Se hará en cuanto se reinicie (${new Date(
          dto.scheduledFor ?? Date.now(),
        ).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}).`,
      };
    }
    return {
      inspection: dto,
      deferred: false,
      message:
        done.status === 'error'
          ? `Google no pudo inspeccionarla: ${done.error ?? 'error desconocido'}`
          : done.status === 'running'
            ? 'Ya se está inspeccionando.'
            : 'Inspección hecha.',
    };
  }

  // ---------------------------------------------------------------- cola

  /**
   * Hace una inspección que espera: reserva la cuota del día (por proyecto y
   * por propiedad, con un candado por propiedad) y llama a Google. Sin cuota,
   * la deja para cuando se reinicie.
   */
  async runOne(id: string, now = new Date()): Promise<'done' | 'error' | 'deferred' | 'skipped'> {
    const claim = await this.admin.$transaction(async (tx) => {
      const row = await tx.seoUrlInspection.findUnique({
        where: { id },
        include: { project: { select: { tenantId: true, technicalSettings: true } } },
      });
      if (!row || row.status !== 'queued') return { kind: 'skipped' as const };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seo-inspect:${row.gscProperty}`}::text))`;
      const day = seoQuotaDay(now);
      const dayDate = new Date(`${day}T00:00:00Z`);
      const [byProject, byProperty] = await Promise.all([
        tx.seoUrlInspection.count({ where: { projectId: row.projectId, quotaDay: dayDate } }),
        tx.seoUrlInspection.count({ where: { gscProperty: row.gscProperty, quotaDay: dayDate } }),
      ]);
      const q = seoInspectionQuota({
        usedByProject: byProject,
        usedByProperty: byProperty,
        cap: this.settingsOf(row.project).inspectionDailyCap,
      });
      if (q.remaining <= 0) {
        await tx.seoUrlInspection.update({
          where: { id },
          data: { scheduledFor: seoNextQuotaReset(now) },
        });
        return { kind: 'deferred' as const };
      }
      const updated = await tx.seoUrlInspection.updateMany({
        where: { id, status: 'queued' },
        data: { status: 'running', quotaDay: dayDate, attempts: { increment: 1 } },
      });
      if (updated.count === 0) return { kind: 'skipped' as const };
      return { kind: 'claimed' as const, row };
    });
    if (claim.kind !== 'claimed') return claim.kind;
    const row = claim.row;
    try {
      const r = await this.client.inspectUrl(row.gscProperty, row.url, 'es-ES');
      const mismatch = seoCanonicalMismatch({
        url: row.url,
        googleCanonical: r.googleCanonical,
        userCanonical: r.userCanonical,
      });
      const finished = await this.admin.seoUrlInspection.update({
        where: { id },
        data: {
          status: 'done',
          inspectedAt: new Date(),
          verdict: r.verdict,
          indexed: seoInspectionIndexed(r.verdict),
          coverageState: r.coverageState,
          robotsTxtState: r.robotsTxtState,
          indexingState: r.indexingState,
          pageFetchState: r.pageFetchState,
          crawledAs: r.crawledAs,
          lastCrawlAt: r.lastCrawlTime ? new Date(r.lastCrawlTime) : null,
          googleCanonical: r.googleCanonical,
          userCanonical: r.userCanonical,
          canonicalMismatch: mismatch,
          result: {
            sitemaps: r.sitemaps,
            referringUrls: r.referringUrls,
            mobileUsability: r.mobileUsability,
            richResults: r.richResults,
            link: r.link,
          } as Prisma.InputJsonValue,
          error: null,
        },
      });
      await this.syncFindings(finished);
      await this.admin.seoProject.update({
        where: { id: row.projectId },
        data: { technicalUpdatedAt: new Date() },
      });
      return 'done';
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 429) {
        // Google cortó (cuota de la propiedad o por minuto): no cuenta y espera al día siguiente.
        await this.admin.seoUrlInspection.update({
          where: { id },
          data: { status: 'queued', quotaDay: null, scheduledFor: seoNextQuotaReset(now) },
        });
        return 'deferred';
      }
      const message =
        err instanceof GoogleApiError
          ? err.status === 403
            ? 'La cuenta de servicio no tiene acceso a la propiedad en Search Console.'
            : `${err.message} (${err.status})`
          : (err as Error).message;
      await this.admin.seoUrlInspection.update({
        where: { id },
        data: { status: 'error', error: message.slice(0, 500) },
      });
      return 'error';
    }
  }

  /**
   * Atiende la cola de un proyecto (o de todos): una inspección tras otra con
   * pausa, hasta vaciarla o quedarse sin cuota (lo demás espera al día
   * siguiente y se avisa una vez).
   */
  async processQueue(projectId?: string): Promise<{ done: number; deferred: number }> {
    const now = new Date();
    // Lo que se quedó «en curso» (el proceso se reinició) vuelve a la cola.
    await this.admin.seoUrlInspection.updateMany({
      where: {
        ...(projectId ? { projectId } : {}),
        status: 'running',
        updatedAt: { lt: new Date(now.getTime() - STUCK_MS) },
      },
      data: { status: 'queued', quotaDay: null },
    });
    let done = 0;
    let deferred = 0;
    const blocked = new Set<string>();
    for (let i = 0; i < QUEUE_BATCH; i++) {
      const next = await this.admin.seoUrlInspection.findFirst({
        where: {
          ...(projectId
            ? { projectId }
            : blocked.size
              ? { projectId: { notIn: [...blocked] } }
              : {}),
          status: 'queued',
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }],
        },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
      });
      if (!next || blocked.has(next.projectId)) break;
      const outcome = await this.runOne(next.id);
      if (outcome === 'done' || outcome === 'error') done++;
      if (outcome === 'deferred') {
        // Sin cuota: todo lo de ese proyecto espera al día siguiente.
        const until = seoNextQuotaReset(new Date());
        const moved = await this.admin.seoUrlInspection.updateMany({
          where: {
            projectId: next.projectId,
            status: 'queued',
            OR: [{ scheduledFor: null }, { scheduledFor: { lt: until } }],
          },
          data: { scheduledFor: until },
        });
        deferred += moved.count + 1;
        blocked.add(next.projectId);
        const project = await this.projects.resolveProject(undefined, next.projectId);
        await this.notifyQuota(project);
        if (projectId) break;
        continue;
      }
      if (this.pauseMs > 0) await new Promise((r) => setTimeout(r, this.pauseMs));
    }
    return { done, deferred };
  }

  /** Programa que la cola de un proyecto se atienda en el worker. */
  async schedule(projectId: string): Promise<void> {
    try {
      await this.queue.add(
        JOB_SEO_INSPECTIONS,
        { projectId },
        {
          jobId: `seo-inspect-${projectId}-${Date.now()}`,
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 1,
        },
      );
    } catch (err) {
      this.logger.warn(`No se pudo programar la inspección: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------- lote programado

  /**
   * Arma el lote de un proyecto y lo deja en la cola. El cron solo lo hace
   * si está activado; «Lanzar el lote ahora» (`force`), siempre.
   */
  async enqueueBatch(
    projectId: string,
    opts: { force?: boolean; now?: Date } = {},
  ): Promise<number> {
    const now = opts.now ?? new Date();
    const project = await this.projects.resolveProject(undefined, projectId);
    const settings = this.settingsOf(project);
    if (!opts.force && (!settings.inspectionBatchEnabled || project.status !== 'active')) return 0;
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
    if (!primary) return 0;
    const candidates: { url: string; reason: SeoInspectionReason }[] = [];

    // URL objetivo de las palabras seguidas de prioridad alta.
    const kws = await this.admin.seoProjectKeyword.findMany({
      where: { projectId, isActive: true, priority: 1, targetUrl: { not: null } },
      select: { targetUrl: true },
      take: 1000,
    });
    for (const k of kws)
      candidates.push({ url: seoAbsoluteUrl(k.targetUrl!, primary.domain), reason: 'target_high' });
    // Hallazgos de indexación abiertos (los de las reglas).
    const findings = await this.admin.seoIndexFinding.findMany({
      where: {
        projectId,
        active: true,
        status: { in: ['new', 'reviewed'] },
        evidence: 'performance',
      },
      orderBy: { impressions: 'desc' },
      select: { url: true },
      take: 500,
    });
    for (const f of findings) candidates.push({ url: f.url, reason: 'index_finding' });
    // Las páginas con más clics de los últimos días.
    const last = primary.dataUntil?.toISOString().slice(0, 10);
    if (last) {
      const from = new Date(
        new Date(`${last}T00:00:00Z`).getTime() - (TOP_PAGES_DAYS - 1) * 86_400_000,
      );
      const pages = await this.admin.$queryRaw<{ page: string }[]>(Prisma.sql`
        SELECT page FROM seo_gsc_metrics
        WHERE domain_id = ${primary.id}::uuid AND grain = 'page' AND page <> ''
          AND date BETWEEN ${from}::date AND ${last}::date
        GROUP BY page ORDER BY SUM(clicks) DESC, SUM(impressions) DESC LIMIT 1000`);
      for (const p of pages) candidates.push({ url: p.page, reason: 'top_clicks' });
    }

    const lastDone = await this.admin.$queryRaw<{ url_key: string; at: Date }[]>(Prisma.sql`
      SELECT url_key, MAX(COALESCE(inspected_at, created_at)) AS at FROM seo_url_inspections
      WHERE project_id = ${projectId}::uuid AND status IN ('done', 'error')
      GROUP BY url_key`);
    const pending = await this.admin.seoUrlInspection.findMany({
      where: { projectId, status: { in: ['queued', 'running'] } },
      select: { urlKey: true },
    });
    const quota = await this.quota(project, now);
    // Solo las URL de los dominios del proyecto (con su forma para la propiedad).
    const resolved: { url: string; reason: SeoInspectionReason }[] = [];
    for (const c of candidates) {
      try {
        resolved.push({ url: this.resolveTarget(project, c.url).url, reason: c.reason });
      } catch {
        // De otro dominio: no se puede inspeccionar con esta propiedad.
      }
    }
    const batch = selectSeoInspectionBatch({
      candidates: resolved,
      lastInspected: new Map(lastDone.map((r) => [r.url_key, new Date(r.at).toISOString()])),
      pending: new Set(pending.map((p) => p.urlKey)),
      now,
      reinspectDays: settings.inspectionReinspectDays,
      max: settings.inspectionBatchMax,
      remaining: quota.remaining - quota.queued,
    });
    if (batch.length === 0) return 0;
    const rows = batch.map((b) => {
      const t = this.resolveTarget(project, b.url);
      return {
        tenantId: project.tenantId,
        projectId,
        domainId: t.domain.id,
        domain: t.domain.domain,
        gscProperty: t.domain.gscProperty,
        url: t.url,
        urlKey: t.urlKey,
        trigger: 'batch' as SeoTechnicalTrigger,
        reason: b.reason,
      };
    });
    const res = await this.admin.seoUrlInspection.createMany({ data: rows, skipDuplicates: true });
    if (res.count > 0) await this.schedule(projectId);
    return res.count;
  }

  /** Cron diario: el lote de cada proyecto que lo tenga activado. */
  async enqueueBatchesAll(): Promise<{ projects: number; queued: number }> {
    const projects = await this.admin.seoProject.findMany({
      where: { status: 'active' },
      select: { id: true, tenantId: true, technicalSettings: true },
    });
    let n = 0;
    let queued = 0;
    for (const p of projects) {
      if (!this.settingsOf(p).inspectionBatchEnabled) continue;
      if (!(await seoProjectEligible(this.admin, p.tenantId))) continue;
      try {
        queued += await this.enqueueBatch(p.id);
        n++;
      } catch (err) {
        this.logger.warn(`[seo-inspect] lote de ${p.id}: ${(err as Error).message}`);
      }
    }
    return { projects: n, queued };
  }

  /** Cron cada hora: los proyectos con inspecciones que ya pueden hacerse. */
  async scheduleDue(): Promise<number> {
    const due = await this.admin.seoUrlInspection.groupBy({
      by: ['projectId'],
      where: {
        status: 'queued',
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }],
      },
    });
    for (const d of due) await this.schedule(d.projectId);
    return due.length;
  }

  // ------------------------------------------------- hallazgos de indexación

  /**
   * Mantiene los hallazgos que salen de la inspección (evidencia
   * «inspection»): «canónica distinta» y «URL objetivo no indexada». Mismo
   * ciclo de vida que los de las reglas: una arreglada vuelve como nueva si
   * una inspección posterior lo sigue viendo.
   */
  async syncFindings(row: InspectionRow): Promise<void> {
    if (row.status !== 'done') return;
    const project = await this.admin.seoProject.findUnique({
      where: { id: row.projectId },
      include: { domains: true },
    });
    if (!project) return;
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
    const keywords = await this.admin.seoProjectKeyword.findMany({
      where: { projectId: row.projectId, isActive: true, targetUrl: { not: null } },
      select: { targetUrl: true, keyword: { select: { keyword: true } } },
    });
    const targetOf = keywords.filter(
      (k) =>
        seoInspectionUrlKey(k.targetUrl!, primary?.domain ?? row.domain) === row.urlKey ||
        seoInspectionUrlKey(k.targetUrl!, row.domain) === row.urlKey,
    );
    const day = (row.inspectedAt ?? new Date()).toISOString().slice(0, 10);
    const reason = seoNotIndexedReason({
      robotsTxtState: row.robotsTxtState,
      indexingState: row.indexingState,
      pageFetchState: row.pageFetchState,
      coverageState: row.coverageState,
      canonicalMismatch: row.canonicalMismatch,
    });
    const items: {
      category: 'canonical_mismatch' | 'not_indexed';
      present: boolean | null;
      reason: string;
    }[] = [
      {
        category: 'canonical_mismatch',
        present: row.canonicalMismatch,
        reason: `La inspección de URL de Google del ${day.split('-').reverse().join('/')} dice que Google usa ${row.googleCanonical ?? '—'} como canónica${row.userCanonical ? ` y la página declara ${row.userCanonical}` : ' (la página no declara ninguna)'}.`,
      },
      {
        category: 'not_indexed',
        present: targetOf.length > 0 ? row.indexed === false : false,
        reason: `Es la URL objetivo de ${targetOf
          .slice(0, 3)
          .map((k) => `«${k.keyword.keyword}»`)
          .join(
            ', ',
          )} y la inspección de URL de Google del ${day.split('-').reverse().join('/')} dice que no está indexada: ${reason}.`,
      },
    ];
    const now = new Date();
    for (const it of items) {
      const key = sha1(`${row.domain}|${row.url}|${it.category}`);
      if (it.present === null) continue;
      if (!it.present) {
        await this.admin.seoIndexFinding.updateMany({
          where: { projectId: row.projectId, key, active: true },
          data: { active: false },
        });
        continue;
      }
      await this.admin.$executeRaw(Prisma.sql`
        INSERT INTO seo_index_findings (
          tenant_id, project_id, domain_id, domain, key, url, category, rule, evidence,
          clicks, impressions, first_date, last_date, reason, action, active, detected_at,
          last_seen_at, created_at, updated_at
        ) VALUES (
          ${project.tenantId}::uuid, ${row.projectId}::uuid, ${row.domainId}::uuid, ${row.domain},
          ${key}, ${row.url}, ${it.category}, 'inspección de URL', 'inspection', 0, 0,
          ${day}::date, ${day}::date, ${it.reason}, ${SEO_INDEX_CATEGORY_ACTIONS[it.category]},
          true, ${now}, ${now}, ${now}, ${now}
        )
        ON CONFLICT (project_id, key) DO UPDATE SET
          domain_id = EXCLUDED.domain_id,
          last_date = EXCLUDED.last_date,
          reason = EXCLUDED.reason,
          action = EXCLUDED.action,
          active = true,
          last_seen_at = EXCLUDED.last_seen_at,
          updated_at = EXCLUDED.updated_at,
          status = CASE WHEN seo_index_findings.status = 'fixed'
              AND EXCLUDED.last_date > (seo_index_findings.resolved_at AT TIME ZONE 'Europe/Madrid')::date
            THEN 'new' ELSE seo_index_findings.status END,
          returned_at = CASE WHEN seo_index_findings.status = 'fixed'
              AND EXCLUDED.last_date > (seo_index_findings.resolved_at AT TIME ZONE 'Europe/Madrid')::date
            THEN EXCLUDED.last_seen_at ELSE seo_index_findings.returned_at END,
          resolved_at = CASE WHEN seo_index_findings.status = 'fixed'
              AND EXCLUDED.last_date > (seo_index_findings.resolved_at AT TIME ZONE 'Europe/Madrid')::date
            THEN NULL ELSE seo_index_findings.resolved_at END`);
    }
  }

  // ----------------------------------------------------------------- avisos

  /** Aviso (una vez al día de la cuota) de que hay inspecciones esperando al día siguiente. */
  async notifyQuota(project: { id: string; tenantId: string | null; name: string }): Promise<void> {
    try {
      const day = seoQuotaDay();
      const since = new Date(Date.now() - 24 * 3600_000);
      const type = 'seo.inspection_quota';
      const title = 'Inspecciones de URL: tope del día alcanzado';
      const body = `Las que faltan se harán cuando se reinicie la cuota de Google (día ${day} en la hora del Pacífico).`;
      if (project.tenantId) {
        const already = await this.admin.notification.count({
          where: { tenantId: project.tenantId, type, createdAt: { gte: since } },
        });
        if (already > 0) return;
        await this.notifications.createForPermission(project.tenantId, 'settings:manage', {
          type,
          title,
          body,
          link: '/seo-advanced?tab=tecnico',
        });
        return;
      }
      const already = await this.admin.superAdminNotification.count({
        where: { type, link: `/admin/seo/${project.id}?tab=tecnico`, createdAt: { gte: since } },
      });
      if (already > 0) return;
      await this.admin.superAdminNotification.create({
        data: {
          type,
          title: `SEO (${project.name}): ${title}`,
          body,
          link: `/admin/seo/${project.id}?tab=tecnico`,
          recipientId: null,
        },
      });
    } catch (err) {
      this.logger.warn(`[seo-inspect] aviso de cuota: ${(err as Error).message}`);
    }
  }

  /** Para comprobar que la URL es del proyecto sin inspeccionar (lo usa PageSpeed). */
  async target(
    owner: SeoOwner,
    projectId: string,
    rawUrl: string,
  ): Promise<Target & { project: ProjectRow }> {
    const project = await this.projects.resolveProject(owner, projectId);
    return { ...this.resolveTarget(project, rawUrl), project };
  }
}
