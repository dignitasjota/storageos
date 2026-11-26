import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SEO_GSC_DAILY_DAYS,
  SEO_GSC_DAILY_GRAINS,
  SEO_GSC_GRAIN_DIMENSIONS,
  SEO_GSC_SEARCH_TYPES,
  SEO_GSC_TOTAL_GRAINS,
  daysBetween,
  shiftDate,
  type SeoGscGrain,
  type SeoSyncKind,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { GoogleApiError, isGoogleTransient } from '../../common/google/google-service-account';
import { isUniqueViolation } from '../../common/prisma-errors';
import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_SEO_GSC_SYNC, QUEUE_SEO } from '../queues/queue-names';
import { SearchConsoleClient, type GscRow } from '../search-console/search-console.client';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

/** Filas como mucho por petición y día (Google pagina de 25.000 en 25.000). */
const MAX_ROWS_PER_REQUEST = 100_000;
/** Filas por inserción. */
const INSERT_CHUNK = 5000;
/** Una transacción grande (los totales de 16 meses) necesita más de 5 s. */
const TX_TIMEOUT = 120_000;

const today = () => new Date().toISOString().slice(0, 10);
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export interface SeoSyncActor {
  userId?: string | null;
  superAdminId?: string | null;
}

/** Id del trabajo en la cola: uno por ejecución (al reanudar no se duplica). */
export const seoJobId = (runId: string) => `seo-gsc-${runId}`;

/**
 * Descarga de Search Console de SEO Avanzado. Cada descarga es una fila de
 * `seo_sync_runs` y un trabajo de la cola `seo`:
 *
 * 1. Los totales del periodo (`site`, `device`, `country`, `search_type`) de
 *    una vez: son pocas filas.
 * 2. Los cruces con búsqueda o página, día a día del más reciente al más
 *    antiguo (Google limita las filas por petición). Tras cada día se guarda
 *    el cursor: si el worker se reinicia, se sigue por el día siguiente.
 *
 * Cada tramo se reescribe entero (se borra y se vuelve a insertar en una
 * transacción): repetir una descarga no duplica y recoge las correcciones que
 * Google hace en los últimos días.
 */
@Injectable()
export class SeoGscSyncService {
  private readonly logger = new Logger(SeoGscSyncService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly client: SearchConsoleClient,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_SEO) private readonly queue: Queue,
  ) {}

  private get initialDays(): number {
    return this.config.get('SEO_GSC_INITIAL_DAYS', { infer: true });
  }

  /**
   * Programa una descarga del dominio. Si ya hay una de ese tipo en cola o en
   * curso, devuelve esa (no se lanza otra). Devuelve el id de la ejecución.
   */
  async enqueue(domainId: string, kind: SeoSyncKind, actor: SeoSyncActor = {}): Promise<string> {
    const domain = await this.admin.seoProjectDomain.findUnique({ where: { id: domainId } });
    if (!domain) throw new Error(`seo domain ${domainId} not found`);
    const active = await this.activeRun(domainId, kind);
    if (active) {
      await this.addJob(active.id);
      return active.id;
    }
    const to = shiftDate(today(), -1);
    const until = dateOnly(domain.dataUntil);
    // La inicial, 16 meses; las demás, desde el último dato (si la descarga
    // falló varios días no quedan huecos) y como poco los últimos 5 días.
    const span =
      kind === 'initial'
        ? this.initialDays
        : Math.min(
            this.initialDays,
            Math.max(SEO_GSC_DAILY_DAYS, (until ? daysBetween(until, to) : 0) + SEO_GSC_DAILY_DAYS),
          );
    const from = shiftDate(to, -(span - 1));
    let runId: string;
    try {
      const run = await this.admin.seoSyncRun.create({
        data: {
          tenantId: domain.tenantId,
          projectId: domain.projectId,
          domainId,
          kind,
          rangeFrom: day(from),
          rangeTo: day(to),
          daysTotal: span,
          createdByUserId: actor.userId ?? null,
          createdBySuperAdminId: actor.superAdminId ?? null,
        },
        select: { id: true },
      });
      runId = run.id;
    } catch (err) {
      // Otra petición la creó a la vez: vale la suya.
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.activeRun(domainId, kind);
      if (!raced) throw err;
      return raced.id;
    }
    await this.addJob(runId);
    return runId;
  }

  private activeRun(domainId: string, kind: SeoSyncKind) {
    return this.admin.seoSyncRun.findFirst({
      where: { domainId, kind, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
  }

  private async addJob(runId: string): Promise<void> {
    await this.queue.add(
      JOB_SEO_GSC_SYNC,
      { runId },
      {
        jobId: seoJobId(runId),
        // El progreso y los fallos viven en `seo_sync_runs`; los reintentos
        // ante Google los hace el cliente.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /** Cancela una descarga: si está en curso, para al terminar el día que lleva. */
  async cancel(runId: string): Promise<void> {
    await this.admin.seoSyncRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    const job = await this.queue.getJob(seoJobId(runId));
    if (job && (await job.isWaiting())) await job.remove().catch(() => undefined);
  }

  /** Tras reiniciar: vuelve a poner en la cola lo que quedó a medias. */
  async resumePending(): Promise<number> {
    const runs = await this.admin.seoSyncRun.findMany({
      // Solo las de Search Console: las de SISTRIX van por su cola.
      where: { status: { in: ['queued', 'running'] }, dataType: null },
      select: { id: true },
    });
    for (const r of runs) await this.addJob(r.id);
    return runs.length;
  }

  /**
   * Descarga de cada día: los dominios conectados de los proyectos activos de
   * la plataforma y de los tenants que tienen SEO Avanzado y no están de baja.
   * Un dominio sin la carga inicial hecha (p. ej. los que vienen de «SEO
   * local») hace la inicial.
   */
  async enqueueDailyAll(): Promise<{ domains: number; enqueued: number }> {
    const domains = await this.admin.seoProjectDomain.findMany({
      where: { connectionStatus: 'connected', project: { status: 'active' } },
      select: { id: true, tenantId: true, initialDoneAt: true },
    });
    const eligible = new Map<string, boolean>();
    let enqueued = 0;
    for (const d of domains) {
      if (d.tenantId) {
        if (!eligible.has(d.tenantId)) {
          eligible.set(d.tenantId, await this.tenantEligible(d.tenantId));
        }
        if (!eligible.get(d.tenantId)) continue;
      }
      // Con otra descarga en marcha en ese dominio, se espera a la de mañana.
      const busy = await this.admin.seoSyncRun.findFirst({
        where: { domainId: d.id, status: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      if (busy) continue;
      await this.enqueue(d.id, d.initialDoneAt ? 'daily' : 'initial');
      enqueued++;
    }
    return { domains: domains.length, enqueued };
  }

  private async tenantEligible(tenantId: string): Promise<boolean> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt || !['active', 'trial'].includes(tenant.status)) return false;
    return tenantHasFeature(this.admin, tenantId, 'seo_advanced');
  }

  /** Hace (o sigue) una descarga. No lanza: un fallo queda en la ejecución. */
  async processRun(runId: string): Promise<void> {
    const run = await this.admin.seoSyncRun.findUnique({
      where: { id: runId },
      include: { domain: true, project: { select: { status: true } } },
    });
    if (!run || !run.domain || !['queued', 'running'].includes(run.status)) return;
    if (run.project.status !== 'active') {
      await this.finish(runId, 'cancelled', 'El proyecto está en pausa.');
      return;
    }
    if (run.tenantId && !(await this.tenantEligible(run.tenantId))) {
      await this.finish(runId, 'cancelled', 'El negocio ya no tiene SEO Avanzado.');
      return;
    }
    await this.admin.seoSyncRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { status: 'running', startedAt: run.startedAt ?? new Date(), error: null },
    });
    const domain = run.domain;
    const from = dateOnly(run.rangeFrom)!;
    const to = dateOnly(run.rangeTo)!;
    try {
      if (!run.totalsDone) {
        const rows = await this.fetchTotals(domain.gscProperty, from, to);
        await this.replace(
          { tenantId: domain.tenantId, domainId: domain.id },
          SEO_GSC_TOTAL_GRAINS,
          { gte: day(from), lte: day(to) },
          rows,
          async (tx, n) => {
            await tx.seoSyncRun.update({
              where: { id: runId },
              data: { totalsDone: true, rows: { increment: n } },
            });
          },
        );
      }
      const cursor = dateOnly(run.cursor);
      for (let d = cursor ? shiftDate(cursor, -1) : to; d >= from; d = shiftDate(d, -1)) {
        if (await this.stopped(runId)) return;
        const rows = await this.fetchDay(domain.gscProperty, d);
        await this.replace(
          { tenantId: domain.tenantId, domainId: domain.id },
          SEO_GSC_DAILY_GRAINS,
          day(d),
          rows,
          async (tx, n) => {
            await tx.seoSyncRun.update({
              where: { id: runId },
              data: { cursor: day(d), daysDone: { increment: 1 }, rows: { increment: n } },
            });
          },
        );
      }
      if (await this.stopped(runId)) return;
      const last = await this.admin.seoGscMetric.aggregate({
        where: { domainId: domain.id, grain: 'site' },
        _max: { date: true },
      });
      const now = new Date();
      await this.admin.seoProjectDomain.update({
        where: { id: domain.id },
        data: {
          lastSyncedAt: now,
          dataUntil: last._max.date,
          connectionStatus: 'connected',
          lastError: null,
          ...(run.kind === 'initial' ? { initialDoneAt: now } : {}),
        },
      });
      await this.finish(runId, 'done', null);
    } catch (err) {
      // El dominio se borró mientras se descargaba: no queda nada que anotar.
      if (!(await this.admin.seoSyncRun.findUnique({ where: { id: runId } }))) return;
      const message = this.errorMessage(err);
      this.logger.warn(`Descarga SEO ${runId} (${domain.domain}) falló: ${message}`);
      await this.finish(runId, 'failed', message);
      const lostAccess =
        err instanceof GoogleApiError && (err.status === 403 || err.status === 404);
      await this.admin.seoProjectDomain.updateMany({
        where: { id: domain.id },
        data: { lastError: message, ...(lostAccess ? { connectionStatus: 'error' } : {}) },
      });
    }
  }

  private async stopped(runId: string): Promise<boolean> {
    const r = await this.admin.seoSyncRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return !r || r.status !== 'running';
  }

  private async finish(
    runId: string,
    status: 'done' | 'failed' | 'cancelled',
    error: string | null,
  ): Promise<void> {
    await this.admin.seoSyncRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { status, error, finishedAt: new Date() },
    });
  }

  private errorMessage(err: unknown): string {
    if (isGoogleTransient(err)) {
      return `Google no responde ahora (${err.status}). Se volverá a intentar en la próxima descarga.`;
    }
    if (err instanceof GoogleApiError) {
      return err.status === 403 || err.status === 404
        ? `Google no deja leer esta propiedad: ${err.message}. Comprueba el acceso de nuestra cuenta en Search Console.`
        : `Google respondió con un error: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  /** Totales del periodo: sitio, dispositivo, país y cada tipo de búsqueda. */
  private async fetchTotals(property: string, from: string, to: string): Promise<MetricInput[]> {
    const out: MetricInput[] = [];
    for (const grain of ['site', 'device', 'country'] as const) {
      const rows = await this.client.query(property, {
        startDate: from,
        endDate: to,
        dimensions: ['date', ...SEO_GSC_GRAIN_DIMENSIONS[grain]],
        maxRows: MAX_ROWS_PER_REQUEST,
      });
      out.push(...rows.map((r) => toMetric(grain, r, '')));
    }
    for (const searchType of SEO_GSC_SEARCH_TYPES) {
      const rows = await this.client.query(property, {
        startDate: from,
        endDate: to,
        dimensions: ['date'],
        searchType,
        maxRows: MAX_ROWS_PER_REQUEST,
      });
      out.push(...rows.map((r) => toMetric('search_type', r, searchType)));
    }
    return out;
  }

  /** Los cruces con búsqueda o página de un día. */
  private async fetchDay(property: string, date: string): Promise<MetricInput[]> {
    const out: MetricInput[] = [];
    for (const grain of SEO_GSC_DAILY_GRAINS) {
      const rows = await this.client.query(property, {
        startDate: date,
        endDate: date,
        dimensions: ['date', ...SEO_GSC_GRAIN_DIMENSIONS[grain]],
        maxRows: MAX_ROWS_PER_REQUEST,
      });
      out.push(...rows.map((r) => toMetric(grain, r, '')));
    }
    return out;
  }

  /**
   * Sustituye lo guardado de esos cruces y fechas por las filas nuevas y anota
   * el progreso en la misma transacción.
   */
  private async replace(
    owner: { tenantId: string | null; domainId: string },
    grains: SeoGscGrain[],
    date: Date | { gte: Date; lte: Date },
    rows: MetricInput[],
    progress: (tx: Prisma.TransactionClient, inserted: number) => Promise<void>,
  ): Promise<void> {
    await this.admin.$transaction(
      async (tx) => {
        await tx.seoGscMetric.deleteMany({
          where: { domainId: owner.domainId, grain: { in: grains }, date },
        });
        let inserted = 0;
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const res = await tx.seoGscMetric.createMany({
            data: rows
              .slice(i, i + INSERT_CHUNK)
              .map((r) => ({ ...r, tenantId: owner.tenantId, domainId: owner.domainId })),
            skipDuplicates: true,
          });
          inserted += res.count;
        }
        await progress(tx, inserted);
      },
      { timeout: TX_TIMEOUT },
    );
  }
}

interface MetricInput {
  grain: SeoGscGrain;
  date: Date;
  query: string;
  page: string;
  country: string;
  device: string;
  searchType: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Fila de la API → fila guardada (las dimensiones que no tiene el cruce, vacías). */
function toMetric(grain: SeoGscGrain, r: GscRow, searchType: string): MetricInput {
  const values: Partial<Record<'query' | 'page' | 'country' | 'device', string>> = {};
  SEO_GSC_GRAIN_DIMENSIONS[grain].forEach((dim, i) => {
    values[dim] = r.keys[i + 1] ?? '';
  });
  return {
    grain,
    date: day(r.keys[0] ?? today()),
    query: (values.query ?? '').slice(0, 500),
    page: (values.page ?? '').slice(0, 2000),
    country: (values.country ?? '').slice(0, 10),
    device: (values.device ?? '').slice(0, 20),
    searchType,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: Math.min(9.999999, Math.round(r.ctr * 1_000_000) / 1_000_000),
    position: Math.round(r.position * 100) / 100,
  };
}
