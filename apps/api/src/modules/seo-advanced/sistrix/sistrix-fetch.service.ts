import { Injectable, Logger } from '@nestjs/common';
import {
  madridToday,
  sistrixQuotaResetAt,
  type SeoProviderKey,
  type SeoSistrixRoutingDto,
  type SeoSistrixWaitReason,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProviderRegistry } from '../providers/seo-data-provider';
import { decideSistrixRoute, type RouteDecision } from '../providers/seo-provider-router';

import { type SeoPool, SistrixConnectionsService } from './sistrix-connections.service';
import {
  SistrixDataError,
  SistrixNotConnectedError,
  SistrixTransientError,
} from './sistrix-errors';
import {
  type SistrixData,
  type SistrixQuery,
  sistrixQueryHash,
  toApiCall,
  toMcpCall,
} from './sistrix-normalizer';

export interface FetchContext {
  pool: SeoPool;
  projectId: string | null;
  runId: string | null;
  userId?: string | null;
  superAdminId?: string | null;
  /** Días que vale la respuesta en la caché. */
  ttlDays: number;
  /** Solo se reutiliza lo guardado más reciente que esto (null = cualquiera vigente). */
  maxAgeMs?: number | null;
  /** Máximo de consultas reales al día en el fondo. */
  maxPerDay: number;
}

export type FetchResult =
  | {
      kind: 'data';
      data: SistrixData | null;
      dataDate: string | null;
      provider: SeoProviderKey;
      fetchedAt: Date;
      fromCache: boolean;
      credits: number;
    }
  | { kind: 'wait'; reason: SeoSistrixWaitReason; until: Date | null }
  | { kind: 'error'; code: string | null; message: string; provider: SeoProviderKey | null };

interface CachedValue {
  outcome: 'ok' | 'empty';
  data: SistrixData | null;
}

/**
 * Hace una consulta a SISTRIX por el proveedor que toque, con caché por fondo
 * (deduplica entre proyectos), registro de cada petición (sin secretos),
 * límite diario, cuota del MCP (7010) y presupuesto de la API.
 */
@Injectable()
export class SistrixFetchService {
  private readonly logger = new Logger(SistrixFetchService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly connections: SistrixConnectionsService,
    private readonly registry: SeoProviderRegistry,
  ) {}

  /** Estado de las conexiones de un fondo y la decisión para una consulta. */
  async route(pool: SeoPool, q?: SistrixQuery, now = new Date()): Promise<RouteDecision> {
    const [mcp, api] = await Promise.all([
      pool === null ? this.connections.find(null, 'sistrix_mcp') : Promise.resolve(null),
      this.connections.find(pool, 'sistrix_api'),
    ]);
    return decideSistrixRoute(
      {
        pool: pool === null ? 'platform' : 'tenant',
        mcp: mcp ? { status: mcp.status, quotaExhaustedUntil: mcp.quotaExhaustedUntil } : null,
        api: api
          ? {
              enabled: api.enabled,
              hasKey: !!api.apiKeyEncrypted,
              authorizedUntil: pool === null ? api.apiAuthorizedUntil : null,
              weeklyBudget: api.weeklyBudget,
              weekSpent: this.connections.weekSpent(api, now),
            }
          : null,
        supportsApi: q ? toApiCall(q) !== null : true,
      },
      now,
    );
  }

  async routing(pool: SeoPool): Promise<SeoSistrixRoutingDto> {
    const d = await this.route(pool);
    return { provider: d.provider, waitReason: d.waitReason };
  }

  private async cached(pool: SeoPool, hash: string, maxAgeMs: number | null | undefined) {
    const now = new Date();
    const row = await this.admin.seoApiCache.findFirst({
      where: {
        tenantId: pool,
        queryHash: hash,
        expiresAt: { gt: now },
        ...(maxAgeMs ? { fetchedAt: { gte: new Date(now.getTime() - maxAgeMs) } } : {}),
      },
    });
    return row;
  }

  private async saveCache(
    pool: SeoPool,
    hash: string,
    provider: SeoProviderKey,
    tool: string,
    view: string | null,
    value: CachedValue,
    dataDate: string | null,
    ttlDays: number,
    fetchedAt: Date,
  ): Promise<void> {
    const expiresAt = new Date(fetchedAt.getTime() + ttlDays * 24 * 3600_000);
    const data = value as unknown as object;
    const date = dataDate ? new Date(`${dataDate}T00:00:00Z`) : null;
    const existing = await this.admin.seoApiCache.findFirst({
      where: { tenantId: pool, queryHash: hash },
      select: { id: true },
    });
    if (existing) {
      await this.admin.seoApiCache.update({
        where: { id: existing.id },
        data: { provider, tool, view, data, dataDate: date, fetchedAt, expiresAt },
      });
      return;
    }
    await this.admin.seoApiCache
      .create({
        data: {
          tenantId: pool,
          queryHash: hash,
          provider,
          tool,
          view,
          data,
          dataDate: date,
          fetchedAt,
          expiresAt,
        },
      })
      .catch(() => undefined);
  }

  private async log(
    ctx: FetchContext,
    entry: {
      provider: SeoProviderKey;
      tool: string;
      view: string | null;
      args: Record<string, unknown>;
      hash: string;
      status: 'ok' | 'empty' | 'error' | 'quota' | 'cached';
      errorCode?: string | null;
      errorMessage?: string | null;
      durationMs?: number;
      credits?: number;
    },
  ): Promise<void> {
    // Por si acaso: ningún argumento con nombre de secreto llega al registro.
    const args = Object.fromEntries(
      Object.entries(entry.args).filter(([k]) => !/key|token|secret|password/i.test(k)),
    );
    await this.admin.seoApiRequest.create({
      data: {
        tenantId: ctx.pool,
        projectId: ctx.projectId,
        runId: ctx.runId,
        provider: entry.provider,
        tool: entry.tool,
        view: entry.view,
        args: args as object,
        queryHash: entry.hash,
        status: entry.status,
        errorCode: entry.errorCode ?? null,
        errorMessage: entry.errorMessage?.slice(0, 500) ?? null,
        durationMs: entry.durationMs ?? 0,
        credits: entry.credits ?? 0,
        createdByUserId: ctx.userId ?? null,
        createdBySuperAdminId: ctx.superAdminId ?? null,
      },
    });
  }

  /**
   * Una consulta. Si el MCP agota la cuota a mitad, queda marcado hasta las
   * 00:05 de mañana y se vuelve a decidir (puede seguir por la API si el
   * super admin la autorizó; si no, se espera).
   */
  async fetch(ctx: FetchContext, q: SistrixQuery): Promise<FetchResult> {
    const hash = sistrixQueryHash(q);
    const hit = await this.cached(ctx.pool, hash, ctx.maxAgeMs);
    if (hit) {
      const value = hit.data as unknown as CachedValue;
      await this.log(ctx, {
        provider: hit.provider as SeoProviderKey,
        tool: hit.tool,
        view: hit.view,
        args: { ...q },
        hash,
        status: 'cached',
      });
      return {
        kind: 'data',
        data: value.outcome === 'ok' ? value.data : null,
        dataDate: hit.dataDate ? hit.dataDate.toISOString().slice(0, 10) : null,
        provider: hit.provider as SeoProviderKey,
        fetchedAt: hit.fetchedAt,
        fromCache: true,
        credits: 0,
      };
    }

    for (let round = 0; round < 3; round++) {
      const decision = await this.route(ctx.pool, q);
      if (decision.provider === null) {
        return { kind: 'wait', reason: decision.waitReason, until: decision.until };
      }
      if ((await this.connections.requestsToday(ctx.pool)) >= ctx.maxPerDay) {
        return { kind: 'wait', reason: 'daily_limit', until: sistrixQuotaResetAt() };
      }
      const provider = this.registry.query(decision.provider);
      const fallbackCall =
        decision.provider === 'sistrix_mcp'
          ? toMcpCall(q)
          : { tool: toApiCall(q)?.method ?? q.op, args: { ...(toApiCall(q)?.params ?? {}) } };
      const started = Date.now();
      let result;
      try {
        result = await provider.query(ctx.pool, q);
      } catch (err) {
        const durationMs = Date.now() - started;
        if (err instanceof SistrixNotConnectedError) {
          return {
            kind: 'wait',
            reason: err.needsReauth ? 'mcp_needs_reauth' : 'not_connected',
            until: null,
          };
        }
        const message =
          err instanceof SistrixTransientError
            ? `SISTRIX no responde ahora: ${err.message}`
            : (err as Error).message;
        const code =
          err instanceof SistrixDataError
            ? err.code
            : err instanceof SistrixTransientError
              ? 'transient'
              : null;
        await this.log(ctx, {
          provider: decision.provider,
          tool: fallbackCall.tool,
          view: typeof fallbackCall.args.view === 'string' ? fallbackCall.args.view : null,
          args: fallbackCall.args,
          hash,
          status: 'error',
          errorCode: code,
          errorMessage: message,
          durationMs,
        });
        await this.markError(ctx.pool, decision.provider, message);
        return { kind: 'error', code, message, provider: decision.provider };
      }
      const durationMs = Date.now() - started;
      const out = result.outcome;
      const base = {
        provider: decision.provider,
        tool: result.tool,
        view: result.view,
        args: result.args,
        hash,
        durationMs,
        credits: result.credits,
      };
      if (out.kind === 'quota') {
        await this.log(ctx, {
          ...base,
          status: 'quota',
          errorCode: '7010',
          errorMessage: out.message,
        });
        if (decision.provider === 'sistrix_mcp') {
          await this.markQuota();
          continue;
        }
        // La API también tiene su tope: se espera a la próxima semana.
        return { kind: 'wait', reason: 'api_budget', until: null };
      }
      if (out.kind === 'error') {
        await this.log(ctx, {
          ...base,
          status: 'error',
          errorCode: out.code,
          errorMessage: out.message,
        });
        await this.markError(ctx.pool, decision.provider, out.message);
        return { kind: 'error', code: out.code, message: out.message, provider: decision.provider };
      }
      const fetchedAt = new Date();
      await this.log(ctx, { ...base, status: out.kind === 'ok' ? 'ok' : 'empty' });
      const value: CachedValue =
        out.kind === 'ok' ? { outcome: 'ok', data: out.data } : { outcome: 'empty', data: null };
      const dataDate = out.kind === 'ok' ? out.dataDate : null;
      await this.saveCache(
        ctx.pool,
        hash,
        decision.provider,
        result.tool,
        result.view,
        value,
        dataDate,
        ctx.ttlDays,
        fetchedAt,
      );
      await this.markSuccess(ctx.pool, decision.provider);
      return {
        kind: 'data',
        data: value.data,
        dataDate,
        provider: decision.provider,
        fetchedAt,
        fromCache: false,
        credits: result.credits,
      };
    }
    return { kind: 'wait', reason: 'mcp_quota', until: sistrixQuotaResetAt() };
  }

  /** Cuota del MCP agotada: se para hasta mañana a las 00:05 y se avisa (una vez al día). */
  async markQuota(now = new Date()): Promise<void> {
    const conn = await this.connections.ensure(null, 'sistrix_mcp');
    const until = sistrixQuotaResetAt(now);
    const today = madridToday(now);
    const notified = conn.quotaNotifiedAt ? madridToday(conn.quotaNotifiedAt) === today : false;
    await this.connections.update(conn.id, {
      quotaExhaustedUntil: until,
      lastError: 'SISTRIX agotó la cuota diaria del MCP (7010).',
      lastErrorAt: now,
      ...(notified ? {} : { quotaNotifiedAt: now }),
    });
    if (!notified) {
      this.logger.warn('SISTRIX: cuota diaria del MCP agotada (7010)');
      await this.connections.notifySuperAdmin(
        'seo.sistrix_quota',
        'SISTRIX agotó la cuota del día',
        'Las consultas de SISTRIX por MCP se han parado y seguirán solas mañana a las 00:05. Si lo necesitas antes, en SEO → Integraciones puedes «Continuar por API» (gasta créditos, con el presupuesto semanal como tope).',
      );
    }
  }

  private async markSuccess(pool: SeoPool, provider: 'sistrix_mcp' | 'sistrix_api'): Promise<void> {
    await this.admin.seoProviderConnection.updateMany({
      where: { tenantId: pool, provider },
      data: { lastSuccessAt: new Date() },
    });
  }

  private async markError(pool: SeoPool, provider: SeoProviderKey, message: string): Promise<void> {
    if (provider !== 'sistrix_mcp' && provider !== 'sistrix_api') return;
    await this.admin.seoProviderConnection.updateMany({
      where: { tenantId: pool, provider },
      data: { lastError: message.slice(0, 500), lastErrorAt: new Date() },
    });
  }
}
