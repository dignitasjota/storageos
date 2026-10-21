import { createSign } from 'node:crypto';

import { Logger } from '@nestjs/common';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Error de una API de Google con su código HTTP. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * Cuenta de servicio de Google de la plataforma (`GSC_SERVICE_ACCOUNT_JSON`):
 * pide los tokens con un JWT firmado con su clave, sin SDK. La usan Search
 * Console y Google Analytics; cada tenant da acceso a esa cuenta en su
 * propiedad.
 */
export class GoogleServiceAccount {
  private readonly logger = new Logger(GoogleServiceAccount.name);
  private readonly key: ServiceAccountKey | null = null;
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(rawJson: string | undefined) {
    if (!rawJson) return;
    try {
      const parsed = JSON.parse(rawJson) as Partial<ServiceAccountKey>;
      if (parsed.client_email && parsed.private_key) {
        this.key = { client_email: parsed.client_email, private_key: parsed.private_key };
      } else {
        this.logger.warn('GSC_SERVICE_ACCOUNT_JSON sin client_email o private_key');
      }
    } catch {
      this.logger.warn('GSC_SERVICE_ACCOUNT_JSON no es un JSON válido');
    }
  }

  get configured(): boolean {
    return this.key != null;
  }

  get email(): string | null {
    return this.key?.client_email ?? null;
  }

  /** Token de acceso para un ámbito (se reutiliza hasta un minuto antes de caducar). */
  async accessToken(scope: string): Promise<string> {
    if (!this.key)
      throw new GoogleApiError('La cuenta de servicio de Google no está configurada', 503);
    const cached = this.tokens.get(scope);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.key.client_email,
      scope,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(this.key.private_key)
      .toString('base64url');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new GoogleApiError(
        `Google no aceptó la cuenta de servicio: ${body.error_description ?? res.status}`,
        502,
      );
    }
    this.tokens.set(scope, {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    });
    return body.access_token;
  }

  /** Llamada autenticada a una API de Google (JSON). */
  async request<T>(scope: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    const token = await this.accessToken(scope);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      throw new GoogleApiError(json.error?.message ?? `Google: ${res.status}`, res.status);
    }
    return json;
  }
}
