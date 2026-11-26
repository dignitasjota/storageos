import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  shiftDate,
  type SearchConsoleDayInput,
  type SearchConsoleDeviceInput,
  type SearchConsoleRowInput,
  type SeoGscSearchType,
} from '@storageos/shared';

import {
  GoogleApiError,
  GoogleServiceAccount,
  isGoogleTransient,
} from '../../common/google/google-service-account';

import type { Env } from '../../config/env.schema';

const API = 'https://www.googleapis.com/webmasters/v3';
/** URL Inspection API (Search Console v1). Admite el ámbito de solo lectura. */
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const PAGE_SIZE = 5000;
const MAX_ROWS = 25_000;
/** Máximo de filas por petición que admite la API. */
const API_ROW_LIMIT = 25_000;
/** Intentos ante un 429 o un 5xx (con espera creciente entre ellos). */
const RETRY_ATTEMPTS = 4;

export type GscQueryDimension = 'date' | 'query' | 'page' | 'country' | 'device';

export interface GscQueryFilter {
  dimension: Exclude<GscQueryDimension, 'date'>;
  operator?: 'equals' | 'notEquals' | 'contains' | 'notContains';
  expression: string;
}

export interface GscQueryOptions {
  startDate: string;
  endDate: string;
  dimensions: GscQueryDimension[];
  /** Tipo de búsqueda (por defecto, la web). */
  searchType?: SeoGscSearchType;
  /** Filtros que se cumplen todos a la vez. */
  filters?: GscQueryFilter[];
  /** Filas por página (máximo 25.000). */
  rowLimit?: number;
  /** Tope de filas en total (se pagina hasta llegar o hasta que no haya más). */
  maxRows?: number;
}

/** Una fila de la API: valores de las dimensiones en el orden pedido. */
export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface GscSitemap {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isSitemapsIndex: boolean;
  warnings: number;
  errors: number;
  /** URL enviadas (suma de los tipos de contenido). */
  submitted: number;
}

/** Lo que devuelve la inspección de URL de Google (los campos que se guardan). */
export interface GscUrlInspection {
  verdict: string | null;
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  crawledAs: string | null;
  sitemaps: string[];
  referringUrls: string[];
  mobileUsability: { verdict: string | null; issues: string[] } | null;
  richResults: { verdict: string | null; types: string[]; issues: string[] } | null;
  link: string | null;
}

interface RawInspection {
  inspectionResult?: {
    inspectionResultLink?: string;
    indexStatusResult?: {
      sitemap?: string[];
      referringUrls?: string[];
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      lastCrawlTime?: string;
      pageFetchState?: string;
      googleCanonical?: string;
      userCanonical?: string;
      crawledAs?: string;
    };
    mobileUsabilityResult?: {
      verdict?: string;
      issues?: { issueType?: string; message?: string }[];
    };
    richResultsResult?: {
      verdict?: string;
      detectedItems?: {
        richResultType?: string;
        items?: { name?: string; issues?: { issueMessage?: string; severity?: string }[] }[];
      }[];
    };
  };
}

/** Respuesta de Google → lo que se guarda (sin suponer campos que pueden faltar). */
export function parseGscInspection(raw: RawInspection): GscUrlInspection {
  const r = raw.inspectionResult ?? {};
  const idx = r.indexStatusResult ?? {};
  const mobile = r.mobileUsabilityResult;
  const rich = r.richResultsResult;
  return {
    verdict: idx.verdict ?? null,
    coverageState: idx.coverageState ?? null,
    robotsTxtState: idx.robotsTxtState ?? null,
    indexingState: idx.indexingState ?? null,
    pageFetchState: idx.pageFetchState ?? null,
    lastCrawlTime: idx.lastCrawlTime ?? null,
    googleCanonical: idx.googleCanonical ?? null,
    userCanonical: idx.userCanonical ?? null,
    crawledAs: idx.crawledAs ?? null,
    sitemaps: idx.sitemap ?? [],
    referringUrls: idx.referringUrls ?? [],
    mobileUsability: mobile
      ? {
          verdict: mobile.verdict ?? null,
          issues: (mobile.issues ?? []).map((i) => i.message ?? i.issueType ?? '').filter(Boolean),
        }
      : null,
    richResults: rich
      ? {
          verdict: rich.verdict ?? null,
          types: (rich.detectedItems ?? []).map((d) => d.richResultType ?? '').filter(Boolean),
          issues: (rich.detectedItems ?? []).flatMap((d) =>
            (d.items ?? []).flatMap((it) =>
              (it.issues ?? []).map((i) => i.issueMessage ?? '').filter(Boolean),
            ),
          ),
        }
      : null,
    link: r.inspectionResultLink ?? null,
  };
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
    return (await this.listSites()).some(
      (s) => s.siteUrl === siteUrl && s.permissionLevel !== 'siteUnverifiedUser',
    );
  }

  /** Propiedades a las que se ha añadido la cuenta de servicio. */
  async listSites(): Promise<GscSite[]> {
    if (this.stub) {
      return [
        { siteUrl: 'sc-domain:trasteros.pro', permissionLevel: 'siteFullUser' },
        { siteUrl: 'https://www.trasteros.pro/', permissionLevel: 'siteRestrictedUser' },
        { siteUrl: 'sc-domain:guardalobox.es', permissionLevel: 'siteFullUser' },
        { siteUrl: 'sc-domain:sin-verificar.es', permissionLevel: 'siteUnverifiedUser' },
      ];
    }
    const res = await this.request<{ siteEntry?: GscSite[] }>('GET', `${API}/sites`);
    return (res.siteEntry ?? []).map((s) => ({
      siteUrl: s.siteUrl,
      permissionLevel: s.permissionLevel,
    }));
  }

  /** Mapas del sitio enviados a Google y su estado (solo lectura). */
  async listSitemaps(siteUrl: string): Promise<GscSitemap[]> {
    if (this.stub) {
      const host = stubHost(siteUrl);
      return [
        {
          path: `https://${host}/sitemap.xml`,
          lastSubmitted: '2026-11-01T08:00:00.000Z',
          lastDownloaded: '2026-11-20T03:00:00.000Z',
          isPending: false,
          isSitemapsIndex: false,
          warnings: 0,
          errors: 0,
          submitted: 42,
        },
      ];
    }
    const res = await this.request<{
      sitemap?: {
        path: string;
        lastSubmitted?: string;
        lastDownloaded?: string;
        isPending?: boolean;
        isSitemapsIndex?: boolean;
        warnings?: string | number;
        errors?: string | number;
        contents?: { submitted?: string | number }[];
      }[];
    }>('GET', `${API}/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
    return (res.sitemap ?? []).map((m) => ({
      path: m.path,
      lastSubmitted: m.lastSubmitted ?? null,
      lastDownloaded: m.lastDownloaded ?? null,
      isPending: m.isPending ?? false,
      isSitemapsIndex: m.isSitemapsIndex ?? false,
      warnings: Number(m.warnings ?? 0),
      errors: Number(m.errors ?? 0),
      submitted: (m.contents ?? []).reduce((n, c) => n + Number(c.submitted ?? 0), 0),
    }));
  }

  /**
   * Consulta de rendimiento con las dimensiones, filtros y tipo de búsqueda
   * pedidos. Pagina hasta `maxRows` (o hasta que Google no devuelva más) y
   * reintenta con espera creciente si Google responde 429 o 5xx.
   */
  async query(siteUrl: string, opts: GscQueryOptions): Promise<GscRow[]> {
    if (this.stub) return stubQuery(siteUrl, opts);
    const pageSize = Math.min(API_ROW_LIMIT, Math.max(1, opts.rowLimit ?? API_ROW_LIMIT));
    const maxRows = opts.maxRows ?? 100_000;
    const out: GscRow[] = [];
    for (let startRow = 0; startRow < maxRows; startRow += pageSize) {
      const res = await this.requestWithRetry<{ rows?: GscRow[] }>(
        'POST',
        `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          startDate: opts.startDate,
          endDate: opts.endDate,
          dimensions: opts.dimensions,
          type: opts.searchType ?? 'web',
          ...(opts.filters && opts.filters.length > 0
            ? {
                dimensionFilterGroups: [
                  {
                    groupType: 'and',
                    filters: opts.filters.map((f) => ({
                      dimension: f.dimension,
                      operator: f.operator ?? 'equals',
                      expression: f.expression,
                    })),
                  },
                ],
              }
            : {}),
          rowLimit: Math.min(pageSize, maxRows - startRow),
          startRow,
        },
      );
      const rows = res.rows ?? [];
      for (const r of rows) {
        out.push({
          keys: r.keys ?? [],
          clicks: Math.round(r.clicks),
          impressions: Math.round(r.impressions),
          ctr: r.ctr ?? (r.impressions > 0 ? r.clicks / r.impressions : 0),
          position: r.position,
        });
      }
      if (rows.length < Math.min(pageSize, maxRows - startRow)) break;
    }
    return out;
  }

  /** Búsquedas por día, consulta y página entre dos fechas (incluidas). */
  async searchAnalytics(
    siteUrl: string,
    startDate: string,
    endDate: string,
  ): Promise<SearchConsoleRowInput[]> {
    if (this.stub) return stubRows(siteUrl, startDate, endDate);
    const rows = await this.query(siteUrl, {
      startDate,
      endDate,
      dimensions: ['date', 'query', 'page'],
      rowLimit: PAGE_SIZE,
      maxRows: MAX_ROWS,
    });
    return rows.map((r) => ({
      date: r.keys[0] ?? '',
      query: r.keys[1] ?? '',
      page: r.keys[2] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
    }));
  }

  /**
   * Totales de cada día (sin repartir por búsqueda): son los que da el panel de
   * Search Console, con las búsquedas poco frecuentes que no salen por búsqueda.
   */
  async searchAnalyticsDays(
    siteUrl: string,
    startDate: string,
    endDate: string,
  ): Promise<SearchConsoleDayInput[]> {
    if (this.stub) {
      // Lo de las búsquedas más un poco de búsquedas que Google no detalla.
      const byDay = new Map<string, SearchConsoleDayInput>();
      for (const r of stubRows(siteUrl, startDate, endDate)) {
        const d = byDay.get(r.date) ?? { date: r.date, clicks: 1, impressions: 15, position: 0 };
        d.position =
          (d.position * d.impressions + r.position * r.impressions) /
          (d.impressions + r.impressions);
        d.clicks += r.clicks;
        d.impressions += r.impressions;
        byDay.set(r.date, d);
      }
      return [...byDay.values()];
    }
    const rows = await this.query(siteUrl, {
      startDate,
      endDate,
      dimensions: ['date'],
      rowLimit: 1000,
      maxRows: 1000,
    });
    return rows.map((r) => ({
      date: r.keys[0] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
    }));
  }

  /** Totales de cada día por dispositivo (MOBILE, DESKTOP, TABLET). */
  async searchAnalyticsDevices(
    siteUrl: string,
    startDate: string,
    endDate: string,
  ): Promise<SearchConsoleDeviceInput[]> {
    if (this.stub) {
      // Dos de cada tres clics desde el móvil.
      return (await this.searchAnalyticsDays(siteUrl, startDate, endDate)).flatMap((d) => [
        {
          date: d.date,
          device: 'MOBILE',
          clicks: Math.round((d.clicks * 2) / 3),
          impressions: Math.round((d.impressions * 2) / 3),
          position: d.position + 0.5,
        },
        {
          date: d.date,
          device: 'DESKTOP',
          clicks: d.clicks - Math.round((d.clicks * 2) / 3),
          impressions: d.impressions - Math.round((d.impressions * 2) / 3),
          position: d.position - 0.5,
        },
      ]);
    }
    const rows = await this.query(siteUrl, {
      startDate,
      endDate,
      dimensions: ['date', 'device'],
      rowLimit: PAGE_SIZE,
      maxRows: MAX_ROWS,
    });
    return rows.map((r) => ({
      date: r.keys[0] ?? '',
      device: r.keys[1] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      position: r.position,
    }));
  }

  /**
   * Inspección de URL (lo que dice Google de una página: si está indexada,
   * su canónica, el último rastreo…). La URL tiene que ser de la propiedad.
   * Cuota de Google: 2.000 al día y 600 al minuto por propiedad. Reintenta
   * ante 429/5xx con espera creciente; si sigue, lanza `GoogleApiError`.
   *
   * Simulado (determinista por la URL): `noindex` → excluida por «noindex»;
   * `canonical` → Google elige la portada; `notfound` → 404; `robots` →
   * bloqueada; `ratelimit` → 429; propiedad con `noaccess` → 403; el resto,
   * indexada.
   */
  async inspectUrl(
    siteUrl: string,
    url: string,
    languageCode = 'es-ES',
  ): Promise<GscUrlInspection> {
    if (this.stub) return stubInspection(siteUrl, url);
    const raw = await this.requestWithRetry<RawInspection>('POST', INSPECT_URL, {
      inspectionUrl: url,
      siteUrl,
      languageCode,
    });
    return parseGscInspection(raw);
  }

  /** Espera base entre reintentos (ms); se dobla en cada intento. */
  retryBaseMs = 1000;

  private request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
    return this.account.request<T>(SCOPE, method, url, body);
  }

  private async requestWithRetry<T>(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<T>(method, url, body);
      } catch (err) {
        if (!isGoogleTransient(err) || attempt >= RETRY_ATTEMPTS) throw err;
        const wait = this.retryBaseMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
}

function stubInspection(siteUrl: string, url: string): GscUrlInspection {
  if (siteUrl.includes('noaccess')) {
    throw new GoogleApiError('User does not have sufficient permission for site', 403);
  }
  const u = url.toLowerCase();
  if (u.includes('ratelimit')) throw new GoogleApiError('Quota exceeded', 429);
  const host = stubHost(url.replace(/^https?:\/\//, 'https://'));
  const base: GscUrlInspection = {
    verdict: 'PASS',
    coverageState: 'Enviada e indexada',
    robotsTxtState: 'ALLOWED',
    indexingState: 'INDEXING_ALLOWED',
    pageFetchState: 'SUCCESSFUL',
    lastCrawlTime: '2026-11-20T08:00:00Z',
    googleCanonical: url,
    userCanonical: url,
    crawledAs: 'MOBILE',
    sitemaps: [`https://${host}/sitemap.xml`],
    referringUrls: [`https://${host}/`],
    mobileUsability: null,
    richResults: null,
    link: `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(siteUrl)}&id=${encodeURIComponent(url)}`,
  };
  if (u.includes('noindex')) {
    return {
      ...base,
      verdict: 'NEUTRAL',
      coverageState: 'Excluida por la etiqueta «noindex»',
      indexingState: 'BLOCKED_BY_META_TAG',
      googleCanonical: null,
    };
  }
  if (u.includes('canonical')) {
    return {
      ...base,
      verdict: 'NEUTRAL',
      coverageState: 'Duplicada: Google ha elegido una versión canónica diferente a la del usuario',
      googleCanonical: `https://${host}/`,
    };
  }
  if (u.includes('notfound')) {
    return {
      ...base,
      verdict: 'FAIL',
      coverageState: 'No se ha encontrado (404)',
      pageFetchState: 'NOT_FOUND',
      googleCanonical: null,
      userCanonical: null,
    };
  }
  if (u.includes('robots')) {
    return {
      ...base,
      verdict: 'NEUTRAL',
      coverageState: 'Bloqueada por robots.txt',
      robotsTxtState: 'DISALLOWED',
      pageFetchState: 'BLOCKED_ROBOTS_TXT',
      googleCanonical: null,
    };
  }
  return base;
}

function stubHost(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

interface StubAtom {
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  position: number;
}

/**
 * Lo que «pasa» un día en la web simulada: las tres búsquedas de `stubRows`
 * repartidas por dispositivo (dos tercios en el móvil) y país (un 10 % de las
 * impresiones desde Francia), más búsquedas que Google no detalla (sin
 * consulta). Determinista: los mismos datos todos los días.
 */
function stubAtoms(siteUrl: string, date: string, searchType: SeoGscSearchType): StubAtom[] {
  const base = `https://${stubHost(siteUrl)}`;
  if (searchType === 'image') {
    return [
      {
        query: 'fotos trasteros',
        page: `${base}/`,
        country: 'esp',
        device: 'DESKTOP',
        clicks: 0,
        impressions: 5,
        position: 8,
      },
    ];
  }
  if (searchType !== 'web') return [];
  const atoms: StubAtom[] = [];
  for (const r of stubRows(siteUrl, date, date)) {
    const mobileClicks = Math.round((r.clicks * 2) / 3);
    const mobileImpr = Math.round((r.impressions * 2) / 3);
    for (const [device, clicks, impressions, delta] of [
      ['MOBILE', mobileClicks, mobileImpr, 0.5],
      ['DESKTOP', r.clicks - mobileClicks, r.impressions - mobileImpr, -0.5],
    ] as const) {
      const abroad = Math.floor(impressions / 10);
      atoms.push({
        query: r.query,
        page: r.page,
        country: 'esp',
        device,
        clicks,
        impressions: impressions - abroad,
        position: r.position + delta,
      });
      if (abroad > 0) {
        atoms.push({
          query: r.query,
          page: r.page,
          country: 'fra',
          device,
          clicks: 0,
          impressions: abroad,
          position: r.position + delta + 3,
        });
      }
    }
  }
  // Búsquedas poco frecuentes: cuentan en los totales, no por búsqueda.
  atoms.push({
    query: '',
    page: `${base}/`,
    country: 'esp',
    device: 'MOBILE',
    clicks: 1,
    impressions: 15,
    position: 12,
  });
  return atoms;
}

/** Agrupa los datos simulados por las dimensiones pedidas, como la API. */
function stubQuery(siteUrl: string, opts: GscQueryOptions): GscRow[] {
  const groups = new Map<string, { keys: string[]; c: number; i: number; w: number }>();
  const withQuery = opts.dimensions.includes('query');
  for (let d = opts.startDate, n = 0; d <= opts.endDate && n < 600; d = shiftDate(d, 1), n++) {
    for (const a of stubAtoms(siteUrl, d, opts.searchType ?? 'web')) {
      if (withQuery && !a.query) continue;
      const values: Record<GscQueryDimension, string> = {
        date: d,
        query: a.query,
        page: a.page,
        country: a.country,
        device: a.device,
      };
      const ok = (opts.filters ?? []).every((f) => {
        const v = values[f.dimension];
        switch (f.operator ?? 'equals') {
          case 'equals':
            return v === f.expression;
          case 'notEquals':
            return v !== f.expression;
          case 'contains':
            return v.includes(f.expression);
          case 'notContains':
            return !v.includes(f.expression);
        }
      });
      if (!ok) continue;
      const keys = opts.dimensions.map((dim) => values[dim]);
      const key = keys.join('\u0000');
      const g = groups.get(key) ?? { keys, c: 0, i: 0, w: 0 };
      g.c += a.clicks;
      g.i += a.impressions;
      g.w += a.position * a.impressions;
      groups.set(key, g);
    }
  }
  const rows = [...groups.values()]
    .filter((g) => g.i > 0)
    .map((g) => ({
      keys: g.keys,
      clicks: g.c,
      impressions: g.i,
      ctr: g.c / g.i,
      position: Math.round((g.w / g.i) * 100) / 100,
    }));
  return rows.slice(0, opts.maxRows ?? rows.length);
}

/** Datos simulados: tres búsquedas en la portada y una página de zona. */
function stubRows(siteUrl: string, startDate: string, endDate: string): SearchConsoleRowInput[] {
  const base = `https://${stubHost(siteUrl)}`;
  const out: SearchConsoleRowInput[] = [];
  for (let d = startDate, i = 0; d <= endDate && i < 500; d = shiftDate(d, 1), i++) {
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
