import { createSign } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { shiftDate, type SearchConsoleRowInput } from '@storageos/shared';

import type { Env } from '../../config/env.schema';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const PAGE_SIZE = 5000;
const MAX_ROWS = 25_000;

export class SearchConsoleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * Cliente de la API de Google Search Console con la cuenta de servicio de la
 * plataforma (JWT firmado con su clave, sin SDK). Cada tenant añade el email
 * de la cuenta como usuario de su propiedad.
 *
 * Con `NODE_ENV=test` o `GSC_MODE=stub` funciona simulado: la propiedad tiene
 * acceso salvo que contenga `noaccess`, y las búsquedas se generan.
 */
@Injectable()
export class SearchConsoleClient {
  private readonly logger = new Logger(SearchConsoleClient.name);
  private readonly account: ServiceAccount | null;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: ConfigService<Env, true>) {
    const raw = config.get('GSC_SERVICE_ACCOUNT_JSON', { infer: true });
    this.account = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
        if (parsed.client_email && parsed.private_key) {
          this.account = { client_email: parsed.client_email, private_key: parsed.private_key };
        } else {
          this.logger.warn('GSC_SERVICE_ACCOUNT_JSON sin client_email o private_key');
        }
      } catch {
        this.logger.warn('GSC_SERVICE_ACCOUNT_JSON no es un JSON válido');
      }
    }
  }

  get stub(): boolean {
    return process.env.GSC_MODE === 'stub' || process.env.NODE_ENV === 'test';
  }

  /** La plataforma puede conectar propiedades. */
  get available(): boolean {
    return this.stub || this.account != null;
  }

  /** Email que el tenant añade como usuario en Search Console. */
  get serviceAccountEmail(): string | null {
    if (this.account) return this.account.client_email;
    return this.stub ? 'seo@trasteros-demo.iam.gserviceaccount.com' : null;
  }

  /** ¿La cuenta de servicio tiene acceso a la propiedad? */
  async hasAccess(siteUrl: string): Promise<boolean> {
    if (this.stub) return !siteUrl.includes('noaccess');
    const res = await this.request<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
      'GET',
      `${API}/sites`,
    );
    return (res.siteEntry ?? []).some(
      (s) => s.siteUrl === siteUrl && s.permissionLevel !== 'siteUnverifiedUser',
    );
  }

  /** Búsquedas por día, consulta y página entre dos fechas (incluidas). */
  async searchAnalytics(
    siteUrl: string,
    startDate: string,
    endDate: string,
  ): Promise<SearchConsoleRowInput[]> {
    if (this.stub) return stubRows(siteUrl, startDate, endDate);
    const out: SearchConsoleRowInput[] = [];
    for (let startRow = 0; startRow < MAX_ROWS; startRow += PAGE_SIZE) {
      const res = await this.request<{
        rows?: {
          keys: [string, string, string];
          clicks: number;
          impressions: number;
          position: number;
        }[];
      }>('POST', `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
        startDate,
        endDate,
        dimensions: ['date', 'query', 'page'],
        rowLimit: PAGE_SIZE,
        startRow,
      });
      const rows = res.rows ?? [];
      for (const r of rows) {
        out.push({
          date: r.keys[0],
          query: r.keys[1],
          page: r.keys[2],
          clicks: Math.round(r.clicks),
          impressions: Math.round(r.impressions),
          position: r.position,
        });
      }
      if (rows.length < PAGE_SIZE) break;
    }
    return out;
  }

  private async accessToken(): Promise<string> {
    if (!this.account) throw new SearchConsoleError('Search Console no está configurado', 503);
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(this.account.private_key)
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
      throw new SearchConsoleError(
        `Google no aceptó la cuenta de servicio: ${body.error_description ?? res.status}`,
        502,
      );
    }
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
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
      throw new SearchConsoleError(
        json.error?.message ?? `Search Console: ${res.status}`,
        res.status,
      );
    }
    return json;
  }
}

/** Datos simulados: tres búsquedas en la portada y una página de zona. */
function stubRows(siteUrl: string, startDate: string, endDate: string): SearchConsoleRowInput[] {
  const host = siteUrl
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const base = `https://${host}`;
  const out: SearchConsoleRowInput[] = [];
  for (let d = startDate, i = 0; d <= endDate && i < 400; d = shiftDate(d, 1), i++) {
    out.push(
      {
        date: d,
        query: 'trasteros cerca de mi',
        page: `${base}/`,
        clicks: 2,
        impressions: 40,
        position: 6.5,
      },
      {
        date: d,
        query: 'alquiler trasteros',
        page: `${base}/precios`,
        clicks: 1,
        impressions: 25,
        position: 9,
      },
      {
        date: d,
        query: 'trasteros mislata',
        page: `${base}/trasteros-en-mislata`,
        clicks: 3,
        impressions: 30,
        position: 3.2,
      },
    );
  }
  return out;
}
