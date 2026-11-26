import {
  type OAuthClientProvider,
  UnauthorizedError,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { type FetchLike, stripRedirectUriOnCodeExchange } from './mcp-fetch';
import {
  SistrixDataError,
  SistrixInvalidGrantError,
  SistrixTransientError,
  SistrixUnauthorizedError,
} from './sistrix-errors';
import { stubMcpResult, stubMcpTools } from './sistrix-stub-data';

import type { McpToolResult } from './sistrix-normalizer';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** Servidor MCP de SISTRIX. */
export const SISTRIX_MCP_URL = 'https://api.sistrix.com/mcp/';
/** Ámbito que pide SISTRIX. */
export const SISTRIX_MCP_SCOPE = 'sistrix';

/** Servidor de autorización descubierto (se guarda en la conexión). */
export interface McpOAuthServer {
  authorizationServerUrl: string;
  metadata: Record<string, unknown> | null;
  /** RFC 8707: el recurso que se autoriza. */
  resource: string | null;
}

/** Cliente registrado (registro dinámico). */
export interface McpClientInfo {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
}

export interface McpTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Todo lo que habla con el servidor MCP de SISTRIX. La implementación real va
 * con el SDK oficial; en tests y con `SISTRIX_MODE=stub`, una simulada en
 * memoria con las respuestas reales grabadas.
 */
export abstract class SistrixMcpGateway {
  abstract readonly simulated: boolean;
  abstract discover(): Promise<McpOAuthServer>;
  abstract register(server: McpOAuthServer, redirectUri: string): Promise<McpClientInfo>;
  abstract authorizationUrl(
    server: McpOAuthServer,
    client: McpClientInfo,
    state: string,
  ): Promise<{ url: string; codeVerifier: string }>;
  abstract exchangeCode(
    server: McpOAuthServer,
    client: McpClientInfo,
    code: string,
    codeVerifier: string,
  ): Promise<McpTokenSet>;
  /** Lanza `SistrixInvalidGrantError` si el refresh token ya no vale. */
  abstract refresh(
    server: McpOAuthServer,
    client: McpClientInfo,
    refreshToken: string,
  ): Promise<McpTokenSet>;
  abstract revoke(server: McpOAuthServer, client: McpClientInfo, token: string): Promise<void>;
  /** Lanza `SistrixUnauthorizedError` (401) o `SistrixTransientError`. */
  abstract listTools(accessToken: string): Promise<McpToolInfo[]>;
  abstract callTool(
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpToolResult>;
}

export const SISTRIX_MCP_GATEWAY = Symbol('SistrixMcpGateway');

const toTokenSet = (t: OAuthTokens, previousRefresh: string | null = null): McpTokenSet => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token ?? previousRefresh,
  expiresAt: typeof t.expires_in === 'number' ? new Date(Date.now() + t.expires_in * 1000) : null,
  scope: t.scope ?? null,
});

const metadataOf = (server: McpOAuthServer): { metadata?: AuthorizationServerMetadata } =>
  server.metadata ? { metadata: server.metadata as unknown as AuthorizationServerMetadata } : {};

const clientInformation = (c: McpClientInfo): OAuthClientInformationMixed => ({
  client_id: c.clientId,
  ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
});

/**
 * Proveedor OAuth del SDK respaldado por la conexión guardada: entrega el
 * token de acceso que se leyó (descifrado) de la base de datos. No entrega el
 * refresh token a propósito: la renovación la hace siempre nuestro servicio,
 * con un bloqueo, porque SISTRIX lo rota y dos renovaciones a la vez dejarían
 * la conexión sin un token válido.
 */
class StoredTokenProvider implements OAuthClientProvider {
  constructor(private readonly accessToken: string) {}
  get redirectUrl(): undefined {
    return undefined;
  }
  get clientMetadata() {
    return { client_name: 'TrasterOS SEO', redirect_uris: [] as string[] };
  }
  clientInformation(): undefined {
    return undefined;
  }
  tokens(): OAuthTokens {
    return { access_token: this.accessToken, token_type: 'Bearer' };
  }
  saveTokens(): void {
    // La renovación no pasa por aquí (ver arriba).
  }
  redirectToAuthorization(): void {
    throw new SistrixUnauthorizedError();
  }
  saveCodeVerifier(): void {
    throw new SistrixUnauthorizedError();
  }
  codeVerifier(): string {
    throw new SistrixUnauthorizedError();
  }
}

/** Fallos del transporte → nuestros errores (pasajero, 401 o de datos). */
function mapTransportError(err: unknown): Error {
  if (err instanceof SistrixUnauthorizedError) return err;
  if (err instanceof UnauthorizedError) return new SistrixUnauthorizedError(err.message);
  if (err instanceof StreamableHTTPError) {
    const status = err.code ?? null;
    if (status === 401) return new SistrixUnauthorizedError(err.message);
    if (status === 429 || (status !== null && status >= 500)) {
      return new SistrixTransientError(err.message, status);
    }
    return new SistrixDataError(err.message, status !== null ? String(status) : null);
  }
  const e = err as { code?: unknown; message?: string };
  // McpError: tiempo agotado (-32001) o conexión cerrada (-32000).
  if (e?.code === -32001 || e?.code === -32000) {
    return new SistrixTransientError(e.message ?? 'Tiempo agotado');
  }
  if (err instanceof TypeError) return new SistrixTransientError(err.message);
  return err instanceof Error ? err : new Error(String(err));
}

/** Implementación real con el SDK oficial (`@modelcontextprotocol/sdk`). */
export class SdkSistrixMcpGateway extends SistrixMcpGateway {
  readonly simulated = false;
  private readonly fetchFn: FetchLike = (url, init) => fetch(url, init);

  async discover(): Promise<McpOAuthServer> {
    const info = await discoverOAuthServerInfo(SISTRIX_MCP_URL, { fetchFn: this.fetchFn });
    const resource =
      (info.resourceMetadata?.resource as string | undefined) ??
      SISTRIX_MCP_URL.replace(/\/+$/, '');
    return {
      authorizationServerUrl: String(info.authorizationServerUrl),
      metadata: (info.authorizationServerMetadata as Record<string, unknown> | undefined) ?? null,
      resource,
    };
  }

  async register(server: McpOAuthServer, redirectUri: string): Promise<McpClientInfo> {
    const info = await registerClient(server.authorizationServerUrl, {
      ...metadataOf(server),
      clientMetadata: {
        client_name: 'TrasterOS SEO',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: SISTRIX_MCP_SCOPE,
      },
      fetchFn: this.fetchFn,
    });
    return {
      clientId: info.client_id,
      clientSecret: info.client_secret ?? null,
      redirectUri,
    };
  }

  async authorizationUrl(server: McpOAuthServer, client: McpClientInfo, state: string) {
    const { authorizationUrl, codeVerifier } = await startAuthorization(
      server.authorizationServerUrl,
      {
        ...metadataOf(server),
        clientInformation: clientInformation(client),
        redirectUrl: client.redirectUri,
        scope: SISTRIX_MCP_SCOPE,
        state,
        ...(server.resource ? { resource: new URL(server.resource) } : {}),
      },
    );
    return { url: authorizationUrl.toString(), codeVerifier };
  }

  async exchangeCode(
    server: McpOAuthServer,
    client: McpClientInfo,
    code: string,
    codeVerifier: string,
  ): Promise<McpTokenSet> {
    const tokens = await exchangeAuthorization(server.authorizationServerUrl, {
      ...metadataOf(server),
      clientInformation: clientInformation(client),
      authorizationCode: code,
      codeVerifier,
      redirectUri: client.redirectUri,
      ...(server.resource ? { resource: new URL(server.resource) } : {}),
      // SISTRIX no acepta `redirect_uri` en el canje (ver `mcp-fetch.ts`).
      fetchFn: stripRedirectUriOnCodeExchange(this.fetchFn),
    });
    return toTokenSet(tokens);
  }

  async refresh(
    server: McpOAuthServer,
    client: McpClientInfo,
    refreshToken: string,
  ): Promise<McpTokenSet> {
    try {
      const tokens = await refreshAuthorization(server.authorizationServerUrl, {
        ...metadataOf(server),
        clientInformation: clientInformation(client),
        refreshToken,
        ...(server.resource ? { resource: new URL(server.resource) } : {}),
        fetchFn: this.fetchFn,
      });
      return toTokenSet(tokens, refreshToken);
    } catch (err) {
      const e = err as { errorCode?: string; message?: string; name?: string };
      if (e?.errorCode === 'invalid_grant' || /invalid_grant/i.test(e?.message ?? '')) {
        throw new SistrixInvalidGrantError(e.message);
      }
      if (err instanceof TypeError) throw new SistrixTransientError(err.message);
      throw err;
    }
  }

  async revoke(server: McpOAuthServer, client: McpClientInfo, token: string): Promise<void> {
    const endpoint = server.metadata?.revocation_endpoint;
    if (typeof endpoint !== 'string') return;
    const body = new URLSearchParams({
      token,
      token_type_hint: 'refresh_token',
      client_id: client.clientId,
    });
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
    await this.fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  private async withClient<T>(accessToken: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'trasteros-seo', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(SISTRIX_MCP_URL), {
      authProvider: new StoredTokenProvider(accessToken),
      fetch: this.fetchFn,
    });
    try {
      await client.connect(transport);
      return await fn(client);
    } catch (err) {
      throw mapTransportError(err);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  listTools(accessToken: string): Promise<McpToolInfo[]> {
    return this.withClient(accessToken, async (c) => {
      const { tools } = await c.listTools(undefined, { timeout: 30_000 });
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
    });
  }

  callTool(
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpToolResult> {
    return this.withClient(accessToken, async (c) => {
      const res = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      return res as McpToolResult;
    });
  }
}

/**
 * Servidor MCP simulado en memoria: responde con los datos grabados de la
 * prueba real y deja forzar los casos raros (cuota agotada, `invalid_grant`,
 * cambio de herramientas, caída). Cuenta las llamadas para los tests.
 */
export class StubSistrixMcpGateway extends SistrixMcpGateway {
  readonly simulated = true;
  /** Fuerza el error 7010 en todas las llamadas. */
  forceQuota = false;
  /** La siguiente renovación responde `invalid_grant`. */
  forceInvalidGrant = false;
  /** Fallos pasajeros antes de responder bien. */
  transientFailures = 0;
  toolsVariant: 'default' | 'changed' = 'default';
  calls: { name: string; args: Record<string, unknown> }[] = [];
  refreshes = 0;
  revoked: string[] = [];
  private seq = 0;
  // Los tokens simulados valen mientras no se invaliden (así sobreviven a un
  // reinicio en desarrollo); un refresh usado deja de valer (rotación).
  private invalidAccess = new Set<string>();
  private usedRefresh = new Set<string>();

  reset(): void {
    this.forceQuota = false;
    this.forceInvalidGrant = false;
    this.transientFailures = 0;
    this.toolsVariant = 'default';
    this.calls = [];
    this.refreshes = 0;
    this.revoked = [];
  }

  private issue(): McpTokenSet {
    this.seq += 1;
    const accessToken = `stub-access-${this.seq}-${Date.now()}`;
    const refreshToken = `stub-refresh-${this.seq}-${Date.now()}`;
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 3600_000),
      scope: 'sistrix',
    };
  }

  /** Invalida un token de acceso (para probar el 401 → renovar). */
  expireAccess(token: string): void {
    this.invalidAccess.add(token);
  }

  async discover(): Promise<McpOAuthServer> {
    return {
      authorizationServerUrl: 'https://stub.sistrix.local/mcp',
      metadata: {
        issuer: 'https://stub.sistrix.local/mcp',
        authorization_endpoint: 'https://stub.sistrix.local/mcp/authorize',
        token_endpoint: 'https://stub.sistrix.local/mcp/token',
        registration_endpoint: 'https://stub.sistrix.local/mcp/register',
        revocation_endpoint: 'https://stub.sistrix.local/mcp/revoke',
        code_challenge_methods_supported: ['S256'],
      },
      resource: 'https://stub.sistrix.local/mcp',
    };
  }

  async register(_server: McpOAuthServer, redirectUri: string): Promise<McpClientInfo> {
    return {
      clientId: `stub-client-${Date.now()}`,
      clientSecret: 'stub-client-secret',
      redirectUri,
    };
  }

  async authorizationUrl(_server: McpOAuthServer, client: McpClientInfo, state: string) {
    const codeVerifier = `stub-verifier-${Date.now()}`;
    const url = new URL('https://stub.sistrix.local/mcp/authorize');
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', client.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), codeVerifier };
  }

  async exchangeCode(
    _server: McpOAuthServer,
    _client: McpClientInfo,
    code: string,
  ): Promise<McpTokenSet> {
    if (code === 'bad-code')
      throw new SistrixDataError('El código de autorización no vale', 'invalid_grant');
    return this.issue();
  }

  async refresh(
    _server: McpOAuthServer,
    _client: McpClientInfo,
    refreshToken: string,
  ): Promise<McpTokenSet> {
    this.refreshes += 1;
    if (
      this.forceInvalidGrant ||
      !refreshToken.startsWith('stub-refresh-') ||
      this.usedRefresh.has(refreshToken)
    ) {
      this.forceInvalidGrant = false;
      throw new SistrixInvalidGrantError('invalid_grant');
    }
    // Rota: el anterior deja de valer.
    this.usedRefresh.add(refreshToken);
    return this.issue();
  }

  async revoke(_server: McpOAuthServer, _client: McpClientInfo, token: string): Promise<void> {
    this.revoked.push(token);
    this.usedRefresh.add(token);
  }

  private check(accessToken: string): void {
    if (!accessToken.startsWith('stub-access-') || this.invalidAccess.has(accessToken)) {
      throw new SistrixUnauthorizedError();
    }
    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      throw new SistrixTransientError('Servidor simulado caído', 503);
    }
  }

  async listTools(accessToken: string): Promise<McpToolInfo[]> {
    this.check(accessToken);
    return stubMcpTools(this.toolsVariant);
  }

  async callTool(
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    this.check(accessToken);
    this.calls.push({ name, args });
    if (this.forceQuota) {
      return {
        content: [{ type: 'text', text: 'SISTRIX API Error (7010): daily request limit reached' }],
        isError: false,
      };
    }
    return stubMcpResult(name, args);
  }
}
