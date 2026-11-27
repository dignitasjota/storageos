import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SistrixConnectionsService } from './sistrix-connections.service';
import {
  SistrixInvalidClientError,
  SistrixInvalidGrantError,
  SistrixNotConnectedError,
  SistrixTransientError,
  SistrixUnauthorizedError,
} from './sistrix-errors';
import {
  SISTRIX_MCP_GATEWAY,
  SistrixMcpGateway,
  type McpClientInfo,
  type McpOAuthServer,
  type McpTokenSet,
  type McpToolInfo,
} from './sistrix-mcp.gateway';
import { SISTRIX_MCP_USED, type McpToolResult, sistrixCallForbidden } from './sistrix-normalizer';

import type { Prisma, SeoProviderConnection } from '@storageos/database';
import type { SeoSistrixToolChangesDto, SeoSistrixToolDto } from '@storageos/shared';

/** Se renueva si al token le queda menos de esto. */
const REFRESH_MARGIN_MS = 2 * 60_000;
/** Tiempo máximo de una llamada a una herramienta. */
export const SISTRIX_CALL_TIMEOUT_MS = 30_000;
/** Reintentos ante fallos pasajeros (red, 5xx, 429), con espera creciente. */
const MAX_ATTEMPTS = 3;

/** Clave del bloqueo de la renovación (una para el MCP de la plataforma). */
export const SISTRIX_REFRESH_LOCK = 'seo.sistrix_mcp.refresh';

export interface StoredTool extends SeoSistrixToolDto {
  inputSchema: Record<string, unknown>;
}

/** Vistas declaradas en el esquema de una herramienta (`view.enum`). */
export function toolViews(schema: Record<string, unknown>): string[] {
  const props = (schema.properties ?? {}) as Record<string, { enum?: unknown }>;
  const values = props.view?.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

export function catalogHash(tools: StoredTool[]): string {
  const canonical = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, views: [...t.views].sort(), schema: t.inputSchema }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Qué cambió entre dos catálogos, y si afecta a lo que usamos. */
export function diffCatalog(before: StoredTool[], after: StoredTool[]): SeoSistrixToolChangesDto {
  const prev = new Map(before.map((t) => [t.name, t]));
  const next = new Map(after.map((t) => [t.name, t]));
  const removedTools = [...prev.keys()].filter((n) => !next.has(n));
  const addedTools = [...next.keys()].filter((n) => !prev.has(n));
  const removedViews: { tool: string; view: string }[] = [];
  for (const [name, t] of prev) {
    const now = next.get(name);
    if (!now) continue;
    for (const v of t.views) if (!now.views.includes(v)) removedViews.push({ tool: name, view: v });
  }
  const affectsUs =
    removedTools.some((n) => n in SISTRIX_MCP_USED) ||
    removedViews.some((r) => SISTRIX_MCP_USED[r.tool]?.includes(r.view) ?? false);
  return { removedTools, addedTools, removedViews, affectsUs };
}

/**
 * Cliente MCP de SISTRIX de la plataforma, respaldado en la base de datos:
 * tokens cifrados, renovación automática con bloqueo (el refresh token rota),
 * catálogo de herramientas y llamadas con reintentos.
 */
@Injectable()
export class SistrixMcpClient {
  private readonly logger = new Logger(SistrixMcpClient.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly connections: SistrixConnectionsService,
    @Inject(SISTRIX_MCP_GATEWAY) readonly gateway: SistrixMcpGateway,
  ) {}

  // --------------------------------------------------------- datos guardados

  server(conn: SeoProviderConnection): McpOAuthServer | null {
    const meta = conn.oauthMetadata as McpOAuthServer | null;
    return meta?.authorizationServerUrl ? meta : null;
  }

  client(conn: SeoProviderConnection): McpClientInfo | null {
    if (!conn.clientInfoEncrypted) return null;
    return JSON.parse(
      this.connections.decrypt(null, 'sistrix_mcp', 'client', conn.clientInfoEncrypted),
    ) as McpClientInfo;
  }

  encryptClient(info: McpClientInfo): string {
    return this.connections.encrypt(null, 'sistrix_mcp', 'client', JSON.stringify(info));
  }

  /** Datos de los tokens para guardar (cifrados). */
  tokenData(tokens: McpTokenSet, previousRefreshEncrypted: string | null = null) {
    return {
      accessTokenEncrypted: this.connections.encrypt(
        null,
        'sistrix_mcp',
        'access',
        tokens.accessToken,
      ),
      refreshTokenEncrypted: tokens.refreshToken
        ? this.connections.encrypt(null, 'sistrix_mcp', 'refresh', tokens.refreshToken)
        : previousRefreshEncrypted,
      tokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
    };
  }

  // ------------------------------------------------------------- tokens

  /** Token de acceso válido (renovado si caduca pronto). */
  async accessToken(): Promise<string> {
    const conn = await this.connections.find(null, 'sistrix_mcp');
    if (!conn || conn.status === 'disconnected' || !conn.accessTokenEncrypted) {
      throw new SistrixNotConnectedError('SISTRIX no está conectado.');
    }
    if (conn.status === 'needs_reauth') {
      throw new SistrixNotConnectedError('Hay que volver a conectar SISTRIX.', true);
    }
    const access = this.connections.decrypt(
      null,
      'sistrix_mcp',
      'access',
      conn.accessTokenEncrypted,
    );
    if (!conn.tokenExpiresAt || conn.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return access;
    }
    return this.refresh(access);
  }

  /**
   * Ejecuta algo con el mismo bloqueo que la renovación: escribir los tokens
   * (reconectar o desconectar) mientras otro proceso renueva dejaría la
   * conexión con tokens que ya no valen.
   */
  withRefreshLock<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SISTRIX_REFRESH_LOCK}))`;
        return fn(tx);
      },
      { timeout: 45_000, maxWait: 30_000 },
    );
  }

  /**
   * Renueva los tokens con un bloqueo de la base de datos: SISTRIX rota el
   * refresh token, así que dos procesos que renovasen a la vez dejarían la
   * conexión con uno que ya no vale. Dentro del bloqueo se vuelve a leer la
   * fila: si otro proceso ya renovó (el token guardado es otro que el que
   * falló y no caduca), se usa el suyo. El nuevo refresh token se guarda en
   * la misma transacción.
   *
   * Si SISTRIX responde `invalid_grant`, la conexión queda «hay que volver a
   * conectar», se avisa al super admin y se paran las tandas.
   */
  async refresh(failedAccess: string | null = null): Promise<string> {
    const outcome = await this.admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SISTRIX_REFRESH_LOCK}))`;
        const conn = await tx.seoProviderConnection.findFirst({
          where: { tenantId: null, provider: 'sistrix_mcp' },
        });
        if (!conn?.refreshTokenEncrypted || !conn.accessTokenEncrypted) {
          return { kind: 'not_connected' as const };
        }
        if (conn.status === 'needs_reauth') return { kind: 'needs_reauth' as const, notify: false };
        const current = this.connections.decrypt(
          null,
          'sistrix_mcp',
          'access',
          conn.accessTokenEncrypted,
        );
        const fresh =
          !!conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
        if (fresh && current !== failedAccess) return { kind: 'ok' as const, access: current };
        const server = this.server(conn);
        const client = this.client(conn);
        if (!server || !client) return { kind: 'needs_reauth' as const, notify: true };
        const refreshToken = this.connections.decrypt(
          null,
          'sistrix_mcp',
          'refresh',
          conn.refreshTokenEncrypted,
        );
        let tokens: McpTokenSet;
        try {
          tokens = await this.gateway.refresh(server, client, refreshToken);
        } catch (err) {
          if (err instanceof SistrixInvalidGrantError) {
            await tx.seoProviderConnection.update({
              where: { id: conn.id },
              data: {
                // Si SISTRIX ya no conoce nuestra aplicación, se registra de nuevo
                // al volver a conectar (no se reutiliza un `client_id` muerto).
                ...(err instanceof SistrixInvalidClientError ? { clientInfoEncrypted: null } : {}),
                status: 'needs_reauth',
                lastError: 'SISTRIX no acepta la renovación: hay que volver a conectar.',
                lastErrorAt: new Date(),
              },
            });
            return { kind: 'needs_reauth' as const, notify: true };
          }
          throw err;
        }
        await tx.seoProviderConnection.update({
          where: { id: conn.id },
          data: this.tokenData(tokens, conn.refreshTokenEncrypted),
        });
        return { kind: 'ok' as const, access: tokens.accessToken };
      },
      { timeout: 45_000, maxWait: 30_000 },
    );
    if (outcome.kind === 'ok') return outcome.access;
    if (outcome.kind === 'not_connected') {
      throw new SistrixNotConnectedError('SISTRIX no está conectado.');
    }
    if (outcome.notify) {
      await this.connections.notifySuperAdmin(
        'seo.sistrix_reauth',
        'Hay que volver a conectar SISTRIX',
        'SISTRIX ya no acepta la renovación de la conexión. Las descargas de SISTRIX se han parado hasta que vuelvas a conectar en SEO → Integraciones.',
      );
    }
    throw new SistrixNotConnectedError('Hay que volver a conectar SISTRIX.', true);
  }

  // ----------------------------------------------------------- llamadas

  /**
   * Una llamada a una herramienta, con renovación ante un 401 (una vez) y
   * reintentos con espera creciente ante fallos pasajeros. Los errores de
   * datos (que SISTRIX devuelve como texto) no se reintentan: los trata el
   * normalizador.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { backoffMs?: number } = {},
  ): Promise<McpToolResult> {
    if (sistrixCallForbidden(name, typeof args.view === 'string' ? args.view : null)) {
      throw new Error(
        `La herramienta ${name} no se usa (necesita proyectos de SISTRIX o gasta créditos)`,
      );
    }
    return this.withRetries(
      (token) => this.gateway.callTool(token, name, args, SISTRIX_CALL_TIMEOUT_MS),
      opts,
    );
  }

  private async withRetries<T>(
    fn: (token: string) => Promise<T>,
    opts: { backoffMs?: number },
  ): Promise<T> {
    const backoff = opts.backoffMs ?? (process.env.NODE_ENV === 'test' ? 5 : 1000);
    let token = await this.accessToken();
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(token);
      } catch (err) {
        if (err instanceof SistrixUnauthorizedError && !refreshed) {
          refreshed = true;
          token = await this.refresh(token);
          continue;
        }
        if (err instanceof SistrixTransientError && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, backoff * 2 ** (attempt - 1)));
          continue;
        }
        throw err;
      }
    }
  }

  // -------------------------------------------------------- herramientas

  storedTools(conn: SeoProviderConnection | null): StoredTool[] {
    return Array.isArray(conn?.tools) ? (conn.tools as unknown as StoredTool[]) : [];
  }

  /**
   * `tools/list`: guarda el catálogo (nombre, descripción, esquema, huella).
   * Si cambia respecto al guardado, lo anota y avisa al super admin cuando
   * desaparece algo que usamos.
   */
  async syncTools(): Promise<{ changed: boolean; changes: SeoSistrixToolChangesDto | null }> {
    const tools = await this.withRetries((token) => this.gateway.listTools(token), {});
    const catalog: StoredTool[] = tools.map((t: McpToolInfo) => ({
      name: t.name,
      description: t.description.slice(0, 2000),
      views: toolViews(t.inputSchema),
      inputSchema: t.inputSchema,
    }));
    const hash = catalogHash(catalog);
    const conn = await this.connections.ensure(null, 'sistrix_mcp');
    const before = this.storedTools(conn);
    const changed = !!conn.toolsHash && conn.toolsHash !== hash;
    const changes = changed ? diffCatalog(before, catalog) : null;
    const now = new Date();
    await this.connections.update(conn.id, {
      tools: catalog as unknown as object,
      toolsHash: hash,
      toolsCheckedAt: now,
      lastSuccessAt: now,
      ...(changed ? { toolsChangedAt: now, toolsChanges: changes as unknown as object } : {}),
    });
    if (changed && changes) {
      const lines = [
        ...changes.removedTools.map((t) => `Ya no está la herramienta ${t}.`),
        ...changes.removedViews.map((r) => `Ya no está la vista ${r.view} de ${r.tool}.`),
        ...changes.addedTools.map((t) => `Herramienta nueva: ${t}.`),
      ];
      this.logger.warn(`SISTRIX cambió sus herramientas: ${lines.join(' ')}`);
      await this.connections.notifySuperAdmin(
        'seo.sistrix_tools_changed',
        changes.affectsUs
          ? 'SISTRIX ha cambiado herramientas que usamos'
          : 'SISTRIX ha cambiado sus herramientas',
        lines.join('\n') || 'Cambió la descripción o los parámetros de alguna herramienta.',
      );
    }
    return { changed, changes };
  }
}
