import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

export type GoCardlessEnvironment = 'sandbox' | 'live';

/** Versión de la API de GoCardless con la que hablamos (header obligatorio). */
const GOCARDLESS_API_VERSION = '2015-07-06';

function baseUrl(environment: GoCardlessEnvironment): string {
  return environment === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';
}

/**
 * Verifica la firma de un webhook de GoCardless: HMAC-SHA256 (hex) del cuerpo
 * crudo con el secret del endpoint, comparado en tiempo constante con el header
 * `Webhook-Signature`. Función pura (sin estado), reutilizable y testeable.
 */
export function verifyGoCardlessSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cliente HTTP fino para la API de GoCardless (sin SDK; `fetch`, como Redsys /
 * Holded / Anthropic). En la Fase 1 solo necesitamos validar la conexión; el
 * flujo de mandato (Billing Request) y el cobro (Payment) llegan en fases
 * posteriores.
 */
@Injectable()
export class GoCardlessClient {
  private readonly logger = new Logger(GoCardlessClient.name);

  /** Llamada genérica autenticada a la API de GoCardless. */
  async request<T = unknown>(args: {
    accessToken: string;
    environment: GoCardlessEnvironment;
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    idempotencyKey?: string;
  }): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${args.accessToken}`,
      'GoCardless-Version': GOCARDLESS_API_VERSION,
      Accept: 'application/json',
    };
    if (args.body !== undefined) headers['Content-Type'] = 'application/json';
    if (args.idempotencyKey) headers['Idempotency-Key'] = args.idempotencyKey;

    const res = await fetch(`${baseUrl(args.environment)}${args.path}`, {
      method: args.method,
      headers,
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    return { status: res.status, data };
  }

  /**
   * Prueba la conexión: lista los `creditors` de la cuenta. Si el token es
   * válido devuelve el nombre del primer acreedor; si no, el motivo.
   */
  async testConnection(
    accessToken: string,
    environment: GoCardlessEnvironment,
  ): Promise<{ ok: boolean; creditorName: string | null; error: string | null }> {
    try {
      const { status, data } = await this.request<{
        creditors?: { name: string }[];
        error?: { message?: string };
      }>({ accessToken, environment, method: 'GET', path: '/creditors?limit=1' });
      if (status === 200) {
        return { ok: true, creditorName: data.creditors?.[0]?.name ?? null, error: null };
      }
      return { ok: false, creditorName: null, error: data.error?.message ?? `HTTP ${status}` };
    } catch (err) {
      this.logger.warn(`GoCardless testConnection falló: ${(err as Error).message}`);
      return { ok: false, creditorName: null, error: (err as Error).message };
    }
  }
}
