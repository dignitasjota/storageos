import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SEO_PLATFORM_COMPETITOR_LIMIT,
  SEO_PLATFORM_KEYWORD_LIMIT,
  SEO_TENANT_LIMITS,
  type SeoProviderKey,
  type SeoSistrixApiDto,
  type SeoSistrixConnectionStatus,
  type SeoSistrixDataType,
  type SeoSistrixIntegrationsDto,
  type SeoSistrixMcpDto,
  type SeoSistrixRequestDto,
  type SeoSistrixRequestsPageDto,
  type SeoSistrixRunDto,
  type SeoSistrixRunStatus,
  type SeoSistrixTestResultDto,
  type SeoSistrixToolChangesDto,
  type SeoSistrixWaitReason,
  type SeoSistrixWorkspaceDto,
  type SeoTenantSistrixDto,
  type UpdateSeoSyncSettingsInput,
  type UpdateSistrixApiSettingsInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';
import {
  apiBudgetRemaining,
  apiAuthorizationUntil,
  mcpUsable,
} from '../providers/seo-provider-router';

import { SistrixApiClient } from './sistrix-api.client';
import { type SeoPool, SistrixConnectionsService } from './sistrix-connections.service';
import { SistrixFetchService } from './sistrix-fetch.service';
import { SistrixMcpClient } from './sistrix-mcp.client';
import {
  normalizeSistrix,
  parseMcpResult,
  sistrixQueryHash,
  toMcpCall,
} from './sistrix-normalizer';
import { SistrixOAuthService } from './sistrix-oauth.service';
import { poolOfProject, type SistrixActor, SistrixSyncService } from './sistrix-sync.service';

import type { Prisma, SeoProviderConnection } from '@storageos/database';

/** Dueño visto desde un endpoint: tenant, plataforma (null) o el super admin leyendo cualquiera (undefined). */
export type SeoOwnerScope = string | null | undefined;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

type ProjectWithRelations = Prisma.SeoProjectGetPayload<{
  include: {
    domains: true;
    competitors: { include: { masterImport: { select: { createdAt: true } } } };
  };
}>;

/**
 * Integraciones de SISTRIX (panel admin), su estado en cada proyecto y la
 * clave de API de los tenants. Nunca devuelve tokens ni claves.
 */
@Injectable()
export class SeoSistrixService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly connections: SistrixConnectionsService,
    private readonly fetcher: SistrixFetchService,
    private readonly sync: SistrixSyncService,
    private readonly mcp: SistrixMcpClient,
    private readonly oauth: SistrixOAuthService,
    private readonly api: SistrixApiClient,
  ) {}

  // ------------------------------------------------------------ proyecto

  /**
   * Proyecto de un dueño. Un tenant lo lee con su contexto (política de filas);
   * el super admin, con la conexión de administración (`undefined` = cualquiera).
   */
  async project(owner: SeoOwnerScope, projectId: string): Promise<ProjectWithRelations> {
    if (typeof owner === 'string') {
      const own = await this.prisma.withTenant(
        (tx) =>
          tx.seoProject.findFirst({
            where: { id: projectId, tenantId: owner },
            select: { id: true },
          }),
        owner,
      );
      if (!own) throw this.notFound();
    }
    const row = await this.admin.seoProject.findFirst({
      where: { id: projectId, ...(owner === undefined ? {} : { tenantId: owner }) },
      include: {
        domains: { orderBy: { createdAt: 'asc' } },
        competitors: {
          orderBy: { createdAt: 'asc' },
          include: { masterImport: { select: { createdAt: true } } },
        },
      },
    });
    if (!row) throw this.notFound();
    return row;
  }

  limits(p: { tenantId: string | null }) {
    return p.tenantId
      ? { competitors: SEO_TENANT_LIMITS.competitors, keywords: SEO_TENANT_LIMITS.keywords }
      : { competitors: SEO_PLATFORM_COMPETITOR_LIMIT, keywords: SEO_PLATFORM_KEYWORD_LIMIT };
  }

  // --------------------------------------------------------------- DTOs

  private mcpDto(conn: SeoProviderConnection | null, names: Map<string, string>): SeoSistrixMcpDto {
    return {
      status: (conn?.status ?? 'disconnected') as SeoSistrixConnectionStatus,
      connectedAt: iso(conn?.connectedAt),
      connectedBy: conn?.connectedBySuperAdminId
        ? (names.get(conn.connectedBySuperAdminId) ?? null)
        : null,
      lastSuccessAt: iso(conn?.lastSuccessAt),
      lastError: conn?.lastError ?? null,
      lastErrorAt: iso(conn?.lastErrorAt),
      tokenExpiresAt: iso(conn?.tokenExpiresAt),
      quotaExhaustedUntil:
        conn?.quotaExhaustedUntil && conn.quotaExhaustedUntil > new Date()
          ? iso(conn.quotaExhaustedUntil)
          : null,
      tools: this.mcp
        .storedTools(conn)
        .map((t) => ({ name: t.name, description: t.description, views: t.views })),
      toolsCheckedAt: iso(conn?.toolsCheckedAt),
      toolsChangedAt: iso(conn?.toolsChangedAt),
      toolsChanges: (conn?.toolsChanges as SeoSistrixToolChangesDto | null) ?? null,
      redirectUri: this.oauth.redirectUri,
    };
  }

  private apiDto(conn: SeoProviderConnection | null): SeoSistrixApiDto {
    return {
      enabled: conn?.enabled ?? false,
      hasKey: !!conn?.apiKeyEncrypted,
      keyLast4: conn?.apiKeyLast4 ?? null,
      weeklyBudget: conn?.weeklyBudget ?? 0,
      weekStart: dateOnly(conn?.weekStart),
      weekSpent: conn ? this.connections.weekSpent(conn) : 0,
      creditsBalance: conn?.creditsBalance ?? null,
      creditsCheckedAt: iso(conn?.creditsCheckedAt),
      lastSuccessAt: iso(conn?.lastSuccessAt),
      lastError: conn?.lastError ?? null,
      lastErrorAt: iso(conn?.lastErrorAt),
      authorizedUntil:
        conn?.apiAuthorizedUntil && conn.apiAuthorizedUntil > new Date()
          ? iso(conn.apiAuthorizedUntil)
          : null,
    };
  }

  private async names(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const [users, admins] = await Promise.all([
      this.admin.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, fullName: true },
      }),
      this.admin.superAdmin.findMany({
        where: { id: { in: unique } },
        select: { id: true, fullName: true },
      }),
    ]);
    return new Map([...users, ...admins].map((u) => [u.id, u.fullName]));
  }

  async runDtos(where: Prisma.SeoSyncRunWhereInput, take = 30): Promise<SeoSistrixRunDto[]> {
    const rows = await this.admin.seoSyncRun.findMany({
      where: { ...where, dataType: { not: null } },
      include: { project: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const names = await this.names(
      rows.flatMap((r) => [r.createdByUserId, r.createdBySuperAdminId]),
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      projectName: r.project.name,
      dataType: r.dataType as SeoSistrixDataType,
      provider: r.provider as SeoProviderKey,
      kind: r.kind === 'manual' ? 'manual' : 'scheduled',
      status: r.status as SeoSistrixRunStatus,
      itemsTotal: r.itemsTotal,
      itemsDone: r.itemsDone,
      itemsFailed: r.itemsFailed,
      itemsOverall: runProgressTotal(r.progress),
      itemsPending: runProgressPending(r.progress),
      pausedReason: (r.pausedReason as SeoSistrixWaitReason | null) ?? null,
      pausedUntil: iso(r.pausedUntil),
      creditsUsed: r.creditsUsed,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      createdBy:
        names.get(r.createdByUserId ?? '') ?? names.get(r.createdBySuperAdminId ?? '') ?? null,
    }));
  }

  // ------------------------------------------------- integraciones (admin)

  async integrations(): Promise<SeoSistrixIntegrationsDto> {
    const [mcpConn, apiConn, settings, routing] = await Promise.all([
      this.connections.find(null, 'sistrix_mcp'),
      this.connections.find(null, 'sistrix_api'),
      this.connections.settings(null),
      this.fetcher.routing(null),
    ]);
    const names = await this.names([mcpConn?.connectedBySuperAdminId]);
    const api = this.apiDto(apiConn);
    const usable = mcpUsable(
      mcpConn ? { status: mcpConn.status, quotaExhaustedUntil: mcpConn.quotaExhaustedUntil } : null,
      new Date(),
    );
    const canContinueByApi =
      !usable && api.enabled && api.hasKey && apiBudgetRemaining(api) > 0 && !api.authorizedUntil;
    const pending = await this.runDtos({
      status: { in: ['queued', 'running', 'waiting'] },
      project: { OR: [{ tenantId: null }, { usePlatformSistrix: true }] },
    });
    return { mcp: this.mcpDto(mcpConn, names), api, settings, routing, canContinueByApi, pending };
  }

  /** Prueba del MCP: visibilidad de trasteros.pro (barata y sin créditos). */
  async testMcp(superAdminId: string): Promise<SeoSistrixTestResultDto> {
    const q = { op: 'visindex' as const, domain: 'trasteros.pro', country: 'es' };
    const call = toMcpCall(q);
    const started = Date.now();
    try {
      const raw = await this.mcp.callTool(call.tool, call.args);
      const outcome = normalizeSistrix(q.op, parseMcpResult(raw));
      const status =
        outcome.kind === 'ok' ? 'ok' : outcome.kind === 'empty' ? 'empty' : outcome.kind;
      await this.admin.seoApiRequest.create({
        data: {
          tenantId: null,
          provider: 'sistrix_mcp',
          tool: call.tool,
          view: 'visindex',
          args: call.args as object,
          queryHash: sistrixQueryHash(q),
          status,
          errorCode:
            outcome.kind === 'quota' ? '7010' : outcome.kind === 'error' ? outcome.code : null,
          errorMessage:
            outcome.kind === 'error' || outcome.kind === 'quota' ? outcome.message : null,
          durationMs: Date.now() - started,
          createdBySuperAdminId: superAdminId,
        },
      });
      if (outcome.kind === 'quota') {
        await this.fetcher.markQuota();
        return {
          ok: false,
          provider: 'sistrix_mcp',
          message: 'SISTRIX agotó la cuota del día (7010).',
        };
      }
      if (outcome.kind === 'error') {
        return { ok: false, provider: 'sistrix_mcp', message: outcome.message };
      }
      const value =
        outcome.kind === 'ok' && outcome.data.op === 'visindex' ? outcome.data.points[0]?.value : 0;
      return {
        ok: true,
        provider: 'sistrix_mcp',
        message: `Conexión correcta. Visibilidad de trasteros.pro: ${value ?? 0}.`,
      };
    } catch (err) {
      return { ok: false, provider: 'sistrix_mcp', message: (err as Error).message };
    }
  }

  async refreshTools(): Promise<SeoSistrixIntegrationsDto> {
    try {
      await this.mcp.syncTools();
    } catch (err) {
      throw new BadRequestException({
        code: 'sistrix_tools_failed',
        message: `No se pudo leer el catálogo de SISTRIX: ${(err as Error).message}`,
      });
    }
    return this.integrations();
  }

  /** «Continuar por API»: autorización expresa que caduca cuando el MCP se reanuda. */
  async authorizeApi(superAdminId: string): Promise<SeoSistrixIntegrationsDto> {
    const [mcpConn, apiConn] = await Promise.all([
      this.connections.find(null, 'sistrix_mcp'),
      this.connections.find(null, 'sistrix_api'),
    ]);
    const api = this.apiDto(apiConn);
    if (!apiConn || !api.enabled || !api.hasKey) {
      throw new BadRequestException({
        code: 'sistrix_api_not_ready',
        message: 'Activa antes la API clásica con su clave.',
      });
    }
    // «Continuar por API» es para cuando el MCP no puede (cuota agotada o sin
    // conexión): con el MCP en marcha no se gastan créditos.
    if (
      mcpUsable(
        mcpConn
          ? { status: mcpConn.status, quotaExhaustedUntil: mcpConn.quotaExhaustedUntil }
          : null,
        new Date(),
      )
    ) {
      throw new BadRequestException({
        code: 'sistrix_mcp_usable',
        message: 'El MCP de SISTRIX funciona: no hace falta gastar créditos de la API.',
      });
    }
    if (apiBudgetRemaining(api) <= 0) {
      throw new BadRequestException({
        code: 'sistrix_api_budget',
        message: 'No queda presupuesto de créditos esta semana: súbelo antes.',
      });
    }
    const until = apiAuthorizationUntil(
      mcpConn?.quotaExhaustedUntil && mcpConn.quotaExhaustedUntil > new Date()
        ? mcpConn.quotaExhaustedUntil
        : null,
    );
    await this.connections.update(apiConn.id, {
      apiAuthorizedUntil: until,
      apiAuthorizedBySuperAdminId: superAdminId,
    });
    await this.sync.wakeWaiting(null);
    return this.integrations();
  }

  async revokeApiAuthorization(): Promise<SeoSistrixIntegrationsDto> {
    await this.admin.seoProviderConnection.updateMany({
      where: { tenantId: null, provider: 'sistrix_api' },
      data: { apiAuthorizedUntil: null, apiAuthorizedBySuperAdminId: null },
    });
    return this.integrations();
  }

  /** Clave, activación y presupuesto de la API de un fondo. */
  async updateApi(pool: SeoPool, input: UpdateSistrixApiSettingsInput): Promise<SeoSistrixApiDto> {
    const conn = await this.connections.ensure(pool, 'sistrix_api');
    const data: Prisma.SeoProviderConnectionUpdateInput = {};
    if (input.apiKey !== undefined) {
      if (input.apiKey === '') {
        Object.assign(data, {
          apiKeyEncrypted: null,
          apiKeyLast4: null,
          enabled: false,
          creditsBalance: null,
          creditsCheckedAt: null,
          status: 'disconnected',
        });
      } else {
        Object.assign(data, {
          apiKeyEncrypted: this.connections.encrypt(pool, 'sistrix_api', 'api_key', input.apiKey),
          apiKeyLast4: input.apiKey.slice(-4),
          creditsBalance: null,
          creditsCheckedAt: null,
          lastError: null,
          lastErrorAt: null,
          status: 'connected',
        });
      }
    }
    if (input.weeklyBudget !== undefined) data.weeklyBudget = input.weeklyBudget;
    if (input.enabled !== undefined) {
      const hasKey = input.apiKey !== undefined ? input.apiKey !== '' : !!conn.apiKeyEncrypted;
      if (input.enabled && !hasKey) {
        throw new BadRequestException({
          code: 'sistrix_api_key_required',
          message: 'Pon antes la clave de API de SISTRIX.',
        });
      }
      data.enabled = input.enabled;
      if (!input.enabled) {
        data.apiAuthorizedUntil = null;
        data.apiAuthorizedBySuperAdminId = null;
      }
    }
    const updated = await this.connections.update(conn.id, data);
    // Con la clave lista, lo que esperaba por ella se pone en marcha.
    if (updated.enabled && updated.apiKeyEncrypted) await this.sync.wakeWaiting(pool);
    return this.apiDto(updated);
  }

  /** Prueba de la clave: el saldo de créditos (no gasta). */
  async testApi(pool: SeoPool): Promise<SeoSistrixTestResultDto> {
    const conn = await this.connections.find(pool, 'sistrix_api');
    const key = this.connections.apiKeyOf(conn);
    if (!conn || !key) {
      throw new BadRequestException({
        code: 'sistrix_api_key_required',
        message: 'No hay clave de API.',
      });
    }
    try {
      const credits = await this.api.credits(key);
      await this.connections.update(conn.id, {
        creditsBalance: credits,
        creditsCheckedAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
        status: 'connected',
      });
      return {
        ok: true,
        provider: 'sistrix_api',
        credits,
        message:
          credits === null
            ? 'Clave correcta.'
            : `Clave correcta. Te quedan ${credits} créditos esta semana.`,
      };
    } catch (err) {
      const message = (err as Error).message;
      await this.connections.update(conn.id, {
        lastError: message,
        lastErrorAt: new Date(),
        status: 'error',
      });
      return { ok: false, provider: 'sistrix_api', message };
    }
  }

  updateSettings(pool: SeoPool, input: UpdateSeoSyncSettingsInput) {
    return this.connections.updateSettings(pool, input);
  }

  async requests(query: {
    pool: SeoPool;
    cursor?: string | undefined;
    status?: string | undefined;
    provider?: string | undefined;
    projectId?: string | undefined;
  }): Promise<SeoSistrixRequestsPageDto> {
    const take = 50;
    const rows = await this.admin.seoApiRequest.findMany({
      where: {
        tenantId: query.pool,
        ...(query.status ? { status: query.status } : {}),
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    const projects = new Map(
      (
        await this.admin.seoProject.findMany({
          where: {
            id: { in: [...new Set(page.map((r) => r.projectId).filter((x): x is string => !!x))] },
          },
          select: { id: true, name: true },
        })
      ).map((p) => [p.id, p.name]),
    );
    const names = await this.names(
      page.flatMap((r) => [r.createdByUserId, r.createdBySuperAdminId]),
    );
    const items: SeoSistrixRequestDto[] = page.map((r) => ({
      id: r.id,
      provider: r.provider as SeoProviderKey,
      tool: r.tool,
      view: r.view,
      args: r.args as Record<string, unknown>,
      status: r.status as SeoSistrixRequestDto['status'],
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      durationMs: r.durationMs,
      credits: r.credits,
      projectId: r.projectId,
      projectName: r.projectId ? (projects.get(r.projectId) ?? null) : null,
      createdBy:
        names.get(r.createdByUserId ?? '') ?? names.get(r.createdBySuperAdminId ?? '') ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length > take ? (page.at(-1)?.id ?? null) : null };
  }

  // ------------------------------------------------------------ proyecto

  async workspace(owner: SeoOwnerScope, projectId: string): Promise<SeoSistrixWorkspaceDto> {
    const p = await this.project(owner, projectId);
    const pool = poolOfProject(p);
    const [routing, settings, configured, keywords, runs, lastRuns] = await Promise.all([
      this.fetcher.routing(pool),
      this.connections.settings(pool),
      this.sync.poolConfigured(pool),
      this.admin.seoProjectKeyword.count({ where: { projectId, isActive: true } }),
      this.runDtos({ projectId }, 20),
      this.admin.seoSyncRun.findMany({
        where: { projectId, dataType: { not: null }, status: { in: ['done', 'failed'] } },
        orderBy: { finishedAt: 'desc' },
        distinct: ['dataType'],
        select: { dataType: true, finishedAt: true, status: true },
      }),
    ]);
    const lastSync: SeoSistrixWorkspaceDto['lastSync'] = {};
    for (const r of lastRuns) {
      if (r.dataType && r.finishedAt) {
        lastSync[r.dataType as SeoSistrixDataType] = {
          at: r.finishedAt.toISOString(),
          status: r.status as SeoSistrixRunStatus,
        };
      }
    }
    const unavailableReason = configured
      ? null
      : pool === null
        ? 'SISTRIX no está conectado en la plataforma.'
        : 'Pon tu clave de API de SISTRIX para ver competidores, volumen de búsquedas y resultados de Google.';
    return {
      projectId,
      pool: pool === null ? 'platform' : 'tenant',
      usePlatformSistrix: p.usePlatformSistrix,
      available: configured,
      unavailableReason,
      routing,
      lastSync,
      frequencies: settings.frequencies,
      limits: this.limits(p),
      counts: { competitors: p.competitors.filter((c) => c.isActive).length, keywords },
      runs,
    };
  }

  /** «Sincronizar ahora» de un tipo de dato. */
  async syncNow(
    owner: SeoOwnerScope,
    projectId: string,
    dataType: SeoSistrixDataType,
    actor: SistrixActor,
  ): Promise<SeoSistrixRunDto> {
    const p = await this.project(owner, projectId);
    if (p.status !== 'active') {
      throw new BadRequestException({
        code: 'seo_project_paused',
        message: 'El proyecto está en pausa: actívalo para descargar.',
      });
    }
    const pool = poolOfProject(p);
    if (!(await this.sync.poolConfigured(pool))) {
      throw new BadRequestException({
        code: 'sistrix_not_configured',
        message:
          pool === null
            ? 'Conecta SISTRIX en SEO → Integraciones.'
            : 'Pon tu clave de API de SISTRIX y actívala.',
      });
    }
    const runId = await this.sync.enqueue(projectId, dataType, 'manual', actor);
    const [dto] = await this.runDtos({ id: runId }, 1);
    return dto!;
  }

  async cancelRun(owner: SeoOwnerScope, runId: string): Promise<SeoSistrixRunDto> {
    const run = await this.admin.seoSyncRun.findFirst({
      where: {
        id: runId,
        dataType: { not: null },
        // La plataforma ve y cancela también las tandas de los tenants que usan
        // su conexión (salen en «pendientes», con el tenant del proyecto).
        ...(owner === undefined
          ? {}
          : owner === null
            ? { project: { OR: [{ tenantId: null }, { usePlatformSistrix: true }] } }
            : { tenantId: owner }),
      },
    });
    if (!run) throw this.notFound();
    if (typeof owner === 'string') await this.project(owner, run.projectId);
    if (!['queued', 'running', 'waiting'].includes(run.status)) {
      throw new BadRequestException({
        code: 'seo_run_not_active',
        message: 'Esa tanda ya terminó.',
      });
    }
    await this.sync.cancel(runId);
    const [dto] = await this.runDtos({ id: runId }, 1);
    return dto!;
  }

  /** Proyecto de tenant que usa la conexión de la plataforma (solo superadmin). */
  async setPlatformSistrix(projectId: string, value: boolean): Promise<SeoSistrixWorkspaceDto> {
    const p = await this.admin.seoProject.findUnique({ where: { id: projectId } });
    if (!p) throw this.notFound();
    if (!p.tenantId) {
      throw new BadRequestException({
        code: 'seo_platform_project',
        message: 'Los proyectos de la plataforma ya usan su conexión.',
      });
    }
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { usePlatformSistrix: value },
    });
    return this.workspace(undefined, projectId);
  }

  // ---------------------------------------------------------- tenant (API)

  async tenantSettings(tenantId: string): Promise<SeoTenantSistrixDto> {
    const project = await this.admin.seoProject.findFirst({
      where: { tenantId },
      select: { usePlatformSistrix: true },
    });
    const conn = await this.connections.find(tenantId, 'sistrix_api');
    const { authorizedUntil: _ignored, ...api } = this.apiDto(conn);
    return {
      usingPlatform: project?.usePlatformSistrix ?? false,
      api,
      settings: await this.connections.settings(tenantId),
    };
  }

  notFound(): NotFoundException {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }
}

function runProgressTotal(progress: unknown): number | null {
  const total = (progress as { total?: unknown } | null)?.total;
  return typeof total === 'number' ? total : null;
}

function runProgressPending(progress: unknown): number {
  const left = (progress as { remaining?: unknown } | null)?.remaining;
  return typeof left === 'number' && left > 0 ? left : 0;
}
