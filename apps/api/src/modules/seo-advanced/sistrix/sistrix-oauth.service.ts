import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaAdminService } from '../../database/prisma-admin.service';

import { SistrixConnectionsService } from './sistrix-connections.service';
import { SistrixMcpClient } from './sistrix-mcp.client';

import type { Env } from '../../../config/env.schema';

/** El `state` de la autorización vale 10 minutos y una sola vez. */
export const SISTRIX_STATE_TTL_MS = 10 * 60_000;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Conexión de la plataforma con SISTRIX por MCP (OAuth 2.0): descubrimiento,
 * registro dinámico (se repite si cambia la dirección de vuelta), PKCE, un
 * `state` firmado, de un solo uso y ligado al super admin, y el canje en la
 * vuelta (`GET /v1/admin/seo/sistrix/callback`).
 */
@Injectable()
export class SistrixOAuthService {
  private readonly logger = new Logger(SistrixOAuthService.name);
  private readonly stateKey: Buffer;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly connections: SistrixConnectionsService,
    private readonly mcp: SistrixMcpClient,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.stateKey = createHash('sha256')
      .update(`seo-sistrix-oauth-state:v1:${config.get('MASTER_ENCRYPTION_KEY', { infer: true })}`)
      .digest();
  }

  /** Dirección de vuelta: la del API (la del panel no sirve: el canje va con secretos). */
  get redirectUri(): string {
    const base = this.config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}/v1/admin/seo/sistrix/callback`;
  }

  private get panelUrl(): string {
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}/admin/seo/integrations`;
  }

  private sign(nonce: string, superAdminId: string): string {
    return createHmac('sha256', this.stateKey)
      .update(`${nonce}.${superAdminId}`)
      .digest('base64url');
  }

  /** Empieza la autorización: devuelve la dirección de SISTRIX a la que ir. */
  async start(superAdminId: string): Promise<{ authorizationUrl: string }> {
    const conn = await this.connections.ensure(null, 'sistrix_mcp');
    let server = this.mcp.server(conn);
    try {
      server = await this.mcp.gateway.discover();
    } catch (err) {
      if (!server) {
        throw new BadRequestException({
          code: 'sistrix_discovery_failed',
          message: `No se pudo contactar con SISTRIX: ${(err as Error).message}`,
        });
      }
    }
    let client = this.mcp.client(conn);
    // Se vuelve a registrar si cambió la dirección de vuelta (otro dominio del API).
    // y cuando la conexión no está viva (un `client_id` muerto no se reutiliza).
    if (!client || client.redirectUri !== this.redirectUri || conn.status !== 'connected') {
      try {
        client = await this.mcp.gateway.register(server, this.redirectUri);
      } catch (err) {
        throw new BadRequestException({
          code: 'sistrix_register_failed',
          message: `SISTRIX no aceptó el registro de la aplicación: ${(err as Error).message}`,
        });
      }
    }
    await this.connections.update(conn.id, {
      oauthMetadata: server as unknown as object,
      clientInfoEncrypted: this.mcp.encryptClient(client),
      redirectUri: this.redirectUri,
    });
    const nonce = randomBytes(24).toString('base64url');
    const state = `${nonce}.${this.sign(nonce, superAdminId)}`;
    const { url, codeVerifier } = await this.mcp.gateway.authorizationUrl(server, client, state);
    await this.admin.seoOauthState.create({
      data: {
        stateHash: sha256(state),
        provider: 'sistrix_mcp',
        superAdminId,
        codeVerifierEncrypted: this.connections.encrypt(
          null,
          'sistrix_mcp',
          'verifier',
          codeVerifier,
        ),
        redirectUri: this.redirectUri,
        expiresAt: new Date(Date.now() + SISTRIX_STATE_TTL_MS),
      },
    });
    // Los `state` caducados no sirven para nada.
    await this.admin.seoOauthState
      .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 3600_000) } } })
      .catch(() => undefined);
    return { authorizationUrl: url };
  }

  /**
   * Vuelta de SISTRIX: comprueba el `state` (firmado, de un solo uso, sin
   * caducar), canjea el código y guarda los tokens cifrados. Devuelve la
   * dirección del panel a la que redirigir (`?sistrix=ok|error`).
   */
  async callback(query: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
  }): Promise<string> {
    const fail = (reason: string) => {
      this.logger.warn(`Conexión con SISTRIX fallida: ${reason}`);
      return `${this.panelUrl}?sistrix=error&reason=${encodeURIComponent(reason)}`;
    };
    const state = query.state ?? '';
    const [nonce, sig, ...rest] = state.split('.');
    if (!nonce || !sig || rest.length > 0) return fail('state');
    const row = await this.admin.seoOauthState.findUnique({ where: { stateHash: sha256(state) } });
    if (!row || row.provider !== 'sistrix_mcp') return fail('state');
    const expected = Buffer.from(this.sign(nonce, row.superAdminId));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return fail('state');
    // Un solo uso: lo reclama el primero que llega.
    const claimed = await this.admin.seoOauthState.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return fail('state_used_or_expired');
    if (query.error || !query.code) return fail(query.error ?? 'no_code');

    const conn = await this.connections.ensure(null, 'sistrix_mcp');
    const server = this.mcp.server(conn);
    const client = this.mcp.client(conn);
    if (!server || !client || client.redirectUri !== row.redirectUri) return fail('client');
    const verifier = this.connections.decrypt(
      null,
      'sistrix_mcp',
      'verifier',
      row.codeVerifierEncrypted,
    );
    let tokens;
    try {
      tokens = await this.mcp.gateway.exchangeCode(server, client, query.code, verifier);
    } catch (err) {
      await this.connections.update(conn.id, {
        lastError: `No se pudo canjear el código: ${(err as Error).message}`,
        lastErrorAt: new Date(),
      });
      return fail('exchange');
    }
    const now = new Date();
    // Con el bloqueo de la renovación: no se pisan los tokens de una en curso.
    await this.mcp.withRefreshLock((tx) =>
      tx.seoProviderConnection.update({
        where: { id: conn.id },
        data: {
          ...this.mcp.tokenData(tokens),
          status: 'connected',
          connectedAt: now,
          connectedBySuperAdminId: row.superAdminId,
          lastError: null,
          lastErrorAt: null,
          lastSuccessAt: now,
          quotaExhaustedUntil: null,
        },
      }),
    );
    // Reconectar el MCP acaba con «Continuar por API» (esa autorización era por la cuota agotada).
    await this.admin.seoProviderConnection.updateMany({
      where: { tenantId: null, provider: 'sistrix_api', apiAuthorizedUntil: { not: null } },
      data: { apiAuthorizedUntil: null, apiAuthorizedBySuperAdminId: null },
    });
    // Catálogo de herramientas al conectar (si falla, se intenta en la tarea diaria).
    await this.mcp.syncTools().catch((err: unknown) => {
      this.logger.warn(`tools/list al conectar: ${(err as Error).message}`);
    });
    return `${this.panelUrl}?sistrix=ok`;
  }

  /** Desconecta: revoca en SISTRIX (si se puede) y borra los tokens. */
  async disconnect(): Promise<void> {
    const conn = await this.connections.find(null, 'sistrix_mcp');
    if (!conn) return;
    const server = this.mcp.server(conn);
    const client = this.mcp.client(conn);
    if (server && client && conn.refreshTokenEncrypted) {
      const refresh = this.connections.decrypt(
        null,
        'sistrix_mcp',
        'refresh',
        conn.refreshTokenEncrypted,
      );
      await this.mcp.gateway.revoke(server, client, refresh).catch((err: unknown) => {
        this.logger.warn(`Revocación en SISTRIX: ${(err as Error).message}`);
      });
    }
    await this.mcp.withRefreshLock((tx) =>
      tx.seoProviderConnection.update({
        where: { id: conn.id },
        data: {
          status: 'disconnected',
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          tokenExpiresAt: null,
          scope: null,
          connectedAt: null,
          connectedBySuperAdminId: null,
          quotaExhaustedUntil: null,
        },
      }),
    );
  }
}
