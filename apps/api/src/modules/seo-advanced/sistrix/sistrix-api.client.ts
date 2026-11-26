import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SistrixDataError, SistrixTransientError } from './sistrix-errors';
import {
  type McpToolResult,
  type SistrixPayload,
  parseApiCredits,
  parseApiResponse,
  parseMcpResult,
} from './sistrix-normalizer';
import { stubMcpResult } from './sistrix-stub-data';

import type { Env } from '../../../config/env.schema';

/** Base de la API clásica. */
export const SISTRIX_API_BASE = 'https://api.sistrix.com';
/** SISTRIX pide al menos 300 ms entre dos peticiones. */
export const SISTRIX_API_MIN_GAP_MS = 300;
const TIMEOUT_MS = 30_000;

/** Método de la API → herramienta y vista del MCP (solo para el modo simulado). */
const STUB_MAP: Record<string, { tool: string; view?: string; key: 'domain' | 'kw' }> = {
  'domain.visibilityindex': { tool: 'domain', view: 'visindex', key: 'domain' },
  'domain.kwcount.seo': { tool: 'domain', view: 'kwcount', key: 'domain' },
  'domain.competitors.seo': { tool: 'domain', view: 'competitors', key: 'domain' },
  'domain.opportunities': { tool: 'domain', view: 'opportunities', key: 'domain' },
  'domain.ideas': { tool: 'domain', view: 'ideas', key: 'domain' },
  'keyword.seo': { tool: 'keyword', view: 'seo', key: 'kw' },
  'keyword.seo.metrics': { tool: 'keyword', view: 'metrics', key: 'kw' },
  'keyword.seo.searchintent': { tool: 'keyword', view: 'searchintent', key: 'kw' },
  'keyword.domain.seo': { tool: 'keyword_domain_seo', key: 'domain' },
  'links.linktargets': { tool: 'links', view: 'linktargets', key: 'domain' },
};

export interface SistrixApiResult {
  payload: SistrixPayload;
  /** Créditos que dice la respuesta que ha gastado. */
  credits: number;
}

/**
 * Cliente de la API clásica de SISTRIX (`fetch`, sin SDK): clave en la
 * consulta, `format=json`, al menos 300 ms entre peticiones y lectura de los
 * créditos gastados de cada respuesta. Simulado con `NODE_ENV=test` o
 * `SISTRIX_MODE=stub` (una clave que empieza por `invalid` falla).
 *
 * La de la plataforma va desactivada por defecto; la de un tenant, con su
 * clave y su presupuesto. Ver `sistrix-normalizer.ts` para el formato.
 */
@Injectable()
export class SistrixApiClient {
  readonly simulated: boolean;
  private lastCallAt = 0;
  /** Peticiones simuladas (para los tests). */
  stubCalls: { method: string; params: Record<string, string> }[] = [];

  constructor(config: ConfigService<Env, true>) {
    this.simulated =
      process.env.NODE_ENV === 'test' || config.get('SISTRIX_MODE', { infer: true }) === 'stub';
  }

  /** Respeta los 300 ms entre peticiones de SISTRIX (por proceso). */
  private async spacing(): Promise<void> {
    const wait = this.lastCallAt + SISTRIX_API_MIN_GAP_MS - Date.now();
    if (wait > 0 && !this.simulated) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  private async request(
    apiKey: string,
    method: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    await this.spacing();
    const url = new URL(`${SISTRIX_API_BASE}/${method}`);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new SistrixTransientError(`No se pudo conectar con SISTRIX: ${(err as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new SistrixTransientError(`SISTRIX respondió ${res.status}`, res.status);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok && body === null) {
      throw new SistrixDataError(`SISTRIX respondió ${res.status}`, String(res.status));
    }
    return body;
  }

  /** Llamada a un método de datos. */
  async call(
    apiKey: string,
    method: string,
    params: Record<string, string>,
  ): Promise<SistrixApiResult> {
    if (this.simulated) return this.stubCall(apiKey, method, params);
    return parseApiResponse(await this.request(apiKey, method, params));
  }

  /** Saldo de créditos (el método `credits` no gasta). */
  async credits(apiKey: string): Promise<number | null> {
    if (this.simulated) {
      if (apiKey.startsWith('invalid'))
        throw new SistrixDataError('La clave de API no es válida', 'invalid_key');
      return apiKey.startsWith('empty') ? 0 : 10_000;
    }
    const body = await this.request(apiKey, 'credits', {});
    const { payload } = parseApiResponse(body);
    if (payload.kind === 'error') throw new SistrixDataError(payload.message, payload.code);
    return parseApiCredits(body);
  }

  private stubCall(
    apiKey: string,
    method: string,
    params: Record<string, string>,
  ): SistrixApiResult {
    this.stubCalls.push({ method, params });
    if (apiKey.startsWith('invalid')) {
      return {
        payload: { kind: 'error', code: 'invalid_key', message: 'La clave de API no es válida' },
        credits: 0,
      };
    }
    const map = STUB_MAP[method];
    if (!map)
      return {
        payload: { kind: 'error', code: null, message: `Método ${method} desconocido` },
        credits: 0,
      };
    const args: Record<string, unknown> = {
      [map.key === 'kw' ? 'keyword' : 'domain']: params[map.key],
      country: params.country,
      ...(map.view ? { view: map.view } : {}),
      ...(params.num ? { limit: Number(params.num) } : {}),
      ...(params.history === 'true' ? { history: true } : {}),
    };
    const result: McpToolResult = stubMcpResult(map.tool, args);
    const payload = parseMcpResult(result);
    // La API cobra por dato devuelto: uno por fila, cinco por palabra en las métricas.
    const rows = payload.kind === 'payload' ? countRows(payload.value) : 0;
    const credits = method === 'keyword.seo.metrics' ? 5 : rows;
    return { payload, credits };
  }
}

function countRows(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) if (Array.isArray(v)) return v.length;
  }
  return 1;
}
