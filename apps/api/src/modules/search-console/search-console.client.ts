import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { shiftDate, type SearchConsoleRowInput } from '@storageos/shared';

import { GoogleServiceAccount } from '../../common/google/google-service-account';

import type { Env } from '../../config/env.schema';

const API = 'https://www.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const PAGE_SIZE = 5000;
const MAX_ROWS = 25_000;

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
  private readonly account: GoogleServiceAccount;

  constructor(config: ConfigService<Env, true>) {
    this.account = new GoogleServiceAccount(
      config.get('GSC_SERVICE_ACCOUNT_JSON', { infer: true }),
    );
  }

  get stub(): boolean {
    return process.env.GSC_MODE === 'stub' || process.env.NODE_ENV === 'test';
  }

  /** La plataforma puede conectar propiedades. */
  get available(): boolean {
    return this.stub || this.account.configured;
  }

  /** Email que el tenant añade como usuario en Search Console. */
  get serviceAccountEmail(): string | null {
    if (this.account.email) return this.account.email;
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

  private request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    return this.account.request<T>(SCOPE, method, url, body);
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
