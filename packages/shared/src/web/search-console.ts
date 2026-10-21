import { z } from 'zod';

import { CITY_PAGE_PREFIX } from './city-pages';

/**
 * Seguimiento de posiciones con Google Search Console (extra «SEO local»).
 * El tenant añade la cuenta de servicio de la plataforma como usuario de su
 * propiedad; cada día se guardan sus búsquedas (fecha, consulta, página).
 */

/** `sc-domain:ejemplo.es` (propiedad de dominio) o `https://ejemplo.es/` (prefijo de URL). */
export const SEARCH_CONSOLE_SITE_RE =
  /^(sc-domain:[a-z0-9-]+(\.[a-z0-9-]+)+|https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\/([^\s]*\/)?)$/i;

export const ConnectSearchConsoleSchema = z.object({
  siteUrl: z
    .string()
    .trim()
    .regex(
      SEARCH_CONSOLE_SITE_RE,
      'Escribe la propiedad tal como sale en Search Console: sc-domain:tudominio.es o https://tudominio.es/',
    ),
});
export type ConnectSearchConsoleInput = z.infer<typeof ConnectSearchConsoleSchema>;

export type SearchConsoleStatus = 'pending' | 'connected' | 'error';

export interface SearchConsoleSettingsDto {
  /** La plataforma tiene cuenta de servicio configurada. */
  available: boolean;
  /** Email que el tenant añade como usuario en Search Console. */
  serviceAccountEmail: string | null;
  siteUrl: string | null;
  status: SearchConsoleStatus | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  /** Informe mensual por correo a los propietarios. */
  monthlyReport: boolean;
}

export const SeoMonthlyReportToggleSchema = z.object({ enabled: z.boolean() });

/** Fila guardada (lo que devuelve Search Console por día, búsqueda y página). */
export interface SearchConsoleRowInput {
  date: string; // YYYY-MM-DD
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface SeoTotalsDto {
  clicks: number;
  impressions: number;
  /** Posición media ponderada por impresiones (1 = la primera). */
  position: number | null;
  /** Clics / impresiones (0–1). */
  ctr: number | null;
}

export interface SeoQueryDto {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
  previousPosition: number | null;
  /** Positivo = sube (mejor posición). */
  change: number | null;
}

export interface SeoPageDto {
  page: string;
  /** Ruta sin dominio. */
  path: string;
  /** Zona si es una página `trasteros-en-<zona>`. */
  areaSlug: string | null;
  clicks: number;
  impressions: number;
  position: number;
  previousPosition: number | null;
  previousClicks: number;
  topQuery: string | null;
}

export interface SeoAlertDto {
  kind: 'page_dropped' | 'page_clicks_dropped' | 'query_dropped';
  label: string;
  detail: string;
}

export interface SeoPositionsDto {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  totals: SeoTotalsDto;
  previousTotals: SeoTotalsDto;
  queries: SeoQueryDto[];
  /**
   * Búsquedas donde ya apareces entre la 4.ª y la 20.ª posición con
   * apariciones suficientes: las más fáciles de subir.
   */
  opportunities: SeoQueryDto[];
  pages: SeoPageDto[];
  alerts: SeoAlertDto[];
  /** Último día con datos (Search Console va 2-3 días por detrás). */
  lastDate: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

interface Agg {
  clicks: number;
  impressions: number;
  /** Σ posición × impresiones (para la media ponderada). */
  weighted: number;
  rows: number;
  positionSum: number;
}

function add(map: Map<string, Agg>, key: string, r: SearchConsoleRowInput) {
  const a = map.get(key) ?? { clicks: 0, impressions: 0, weighted: 0, rows: 0, positionSum: 0 };
  a.clicks += r.clicks;
  a.impressions += r.impressions;
  a.weighted += r.position * r.impressions;
  a.rows += 1;
  a.positionSum += r.position;
  map.set(key, a);
}

function avgPosition(a: Agg): number {
  return round1(a.impressions > 0 ? a.weighted / a.impressions : a.positionSum / a.rows);
}

function totalsOf(rows: SearchConsoleRowInput[]): SeoTotalsDto {
  const all: Agg = { clicks: 0, impressions: 0, weighted: 0, rows: 0, positionSum: 0 };
  for (const r of rows) {
    all.clicks += r.clicks;
    all.impressions += r.impressions;
    all.weighted += r.position * r.impressions;
    all.rows += 1;
    all.positionSum += r.position;
  }
  return {
    clicks: all.clicks,
    impressions: all.impressions,
    position: all.rows > 0 ? avgPosition(all) : null,
    ctr: all.impressions > 0 ? Math.round((all.clicks / all.impressions) * 1000) / 1000 : null,
  };
}

/** Ruta sin dominio de una URL de Search Console. */
export function pagePath(page: string): string {
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(page);
  return m ? m[1] || '/' : page;
}

/** Zona de una página `…/trasteros-en-<zona>` (también bajo `/s/<tenant>/`). */
export function areaSlugOfPage(page: string): string | null {
  const segments = pagePath(page).split(/[?#]/)[0]!.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last.startsWith(CITY_PAGE_PREFIX) ? last.slice(CITY_PAGE_PREFIX.length) : null;
}

/** Suma `days` días a una fecha `YYYY-MM-DD`. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resumen del periodo `days` días que acaba en el último día con datos,
 * comparado con el periodo anterior de la misma duración.
 */
export function summarizeSearchConsole(
  rows: SearchConsoleRowInput[],
  days: number,
): SeoPositionsDto {
  const lastDate = rows.reduce<string | null>((m, r) => (!m || r.date > m ? r.date : m), null);
  const to = lastDate ?? new Date().toISOString().slice(0, 10);
  const from = shiftDate(to, -(days - 1));
  const previousTo = shiftDate(from, -1);
  const previousFrom = shiftDate(previousTo, -(days - 1));
  return summarizeRange(rows, { from, to, previousFrom, previousTo }, lastDate);
}

/** Primer y último día del mes natural anterior a `date` (YYYY-MM-DD). */
export function previousMonthRange(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** Resumen de un rango concreto frente a otro (p. ej. un mes frente al anterior). */
export function summarizeRange(
  rows: SearchConsoleRowInput[],
  range: { from: string; to: string; previousFrom: string; previousTo: string },
  lastDate: string | null = null,
): SeoPositionsDto {
  const { from, to, previousFrom, previousTo } = range;
  const current = rows.filter((r) => r.date >= from && r.date <= to);
  const previous = rows.filter((r) => r.date >= previousFrom && r.date <= previousTo);

  const byQuery = new Map<string, Agg>();
  const prevByQuery = new Map<string, Agg>();
  const byPage = new Map<string, Agg>();
  const prevByPage = new Map<string, Agg>();
  const topQueryOfPage = new Map<string, { query: string; impressions: number }>();
  const pageQuery = new Map<string, Agg>();
  for (const r of current) {
    add(byQuery, r.query, r);
    add(byPage, r.page, r);
    add(pageQuery, `${r.page}\u0000${r.query}`, r);
  }
  for (const r of previous) {
    add(prevByQuery, r.query, r);
    add(prevByPage, r.page, r);
  }
  for (const [key, a] of pageQuery) {
    const [page, query] = key.split('\u0000') as [string, string];
    const best = topQueryOfPage.get(page);
    if (!best || a.impressions > best.impressions) {
      topQueryOfPage.set(page, { query, impressions: a.impressions });
    }
  }

  const queries: SeoQueryDto[] = [...byQuery.entries()]
    .map(([query, a]) => {
      const prev = prevByQuery.get(query);
      const position = avgPosition(a);
      const previousPosition = prev ? avgPosition(prev) : null;
      return {
        query,
        clicks: a.clicks,
        impressions: a.impressions,
        position,
        previousPosition,
        change: previousPosition != null ? round1(previousPosition - position) : null,
      };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const opportunities = queries
    .filter((q) => q.position >= 4 && q.position <= 20 && q.impressions >= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);

  const pages: SeoPageDto[] = [...byPage.entries()]
    .map(([page, a]) => {
      const prev = prevByPage.get(page);
      return {
        page,
        path: pagePath(page),
        areaSlug: areaSlugOfPage(page),
        clicks: a.clicks,
        impressions: a.impressions,
        position: avgPosition(a),
        previousPosition: prev ? avgPosition(prev) : null,
        previousClicks: prev?.clicks ?? 0,
        topQuery: topQueryOfPage.get(page)?.query ?? null,
      };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 50);

  const alerts: SeoAlertDto[] = [];
  for (const p of pages) {
    if (p.previousPosition != null && p.impressions >= 20 && p.position - p.previousPosition >= 3) {
      alerts.push({
        kind: 'page_dropped',
        label: p.path,
        detail: `Ha bajado de la posición ${p.previousPosition} a la ${p.position}.`,
      });
    }
    if (p.previousClicks >= 10 && p.clicks <= p.previousClicks / 2) {
      alerts.push({
        kind: 'page_clicks_dropped',
        label: p.path,
        detail: `De ${p.previousClicks} a ${p.clicks} clics respecto al periodo anterior.`,
      });
    }
  }
  for (const q of queries.slice(0, 20)) {
    if (q.change != null && q.change <= -3 && q.impressions >= 20) {
      alerts.push({
        kind: 'query_dropped',
        label: q.query,
        detail: `Ha bajado de la posición ${q.previousPosition} a la ${q.position}.`,
      });
    }
  }

  return {
    from,
    to,
    previousFrom,
    previousTo,
    totals: totalsOf(current),
    previousTotals: totalsOf(previous),
    queries: queries.slice(0, 50),
    opportunities,
    pages,
    alerts: alerts.slice(0, 10),
    lastDate,
  };
}

/** Informe mensual de SEO (panel y correo). */
export interface SeoMonthlyReportDto {
  /** `YYYY-MM` del mes del informe. */
  month: string;
  /** «octubre de 2026». */
  label: string;
  summary: SeoPositionsDto;
  /** Qué hacer este mes, de más a menos importante. */
  tips: string[];
}

/** Página de zona tal como la ve el panel (para los consejos). */
export interface SeoReportAreaPage {
  slug: string;
  name: string;
  kind: 'city' | 'nearby';
  warnings: string[];
  redirect: unknown;
}

const LOCAL_QUERY_RE =
  /^(?:alquiler (?:de )?)?(?:trasteros?|guardamuebles|minialmacenes?)(?: (?:en|de))? (.+)$/;
const NOT_A_PLACE = new Set([
  'cerca',
  'cerca de mi',
  'cerca de mí',
  'baratos',
  'barato',
  'precio',
  'precios',
  'pequeños',
  'pequeño',
  'grandes',
  'grande',
  '24 horas',
  'particulares',
  'para empresas',
  'online',
]);

function citySlugOf(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Consejos del informe: qué mejorar con los datos del mes. */
export function seoReportTips(
  summary: SeoPositionsDto,
  areaPages: SeoReportAreaPage[],
  limit = 6,
): string[] {
  const tips: string[] = [];
  for (const a of summary.alerts.filter((x) => x.kind !== 'query_dropped').slice(0, 2)) {
    tips.push(`Revisa ${a.label}: ${a.detail.charAt(0).toLowerCase()}${a.detail.slice(1)}`);
  }
  for (const q of summary.opportunities.slice(0, 3)) {
    tips.push(
      `«${q.query}»: sales en la posición ${String(q.position).replace('.', ',')} con ${q.impressions} apariciones. Si mejoras el texto de la página que la trabaja, puedes subir a los primeros puestos.`,
    );
  }
  for (const p of areaPages) {
    if (p.redirect) continue;
    const label = `«Trasteros ${p.kind === 'nearby' ? 'cerca de' : 'en'} ${p.name}»`;
    if (p.warnings.includes('no_intro')) {
      tips.push(`${label} no tiene texto propio: redáctalo con IA en Páginas de zona.`);
    } else if (p.warnings.includes('short_intro')) {
      tips.push(`${label} tiene poco texto: amplíalo para que Google la tenga en cuenta.`);
    }
  }
  const known = new Set(areaPages.map((p) => p.slug));
  const suggested = new Set<string>();
  for (const q of summary.queries) {
    if (q.impressions < 10) continue;
    const place = LOCAL_QUERY_RE.exec(q.query.trim().toLowerCase())?.[1]?.trim();
    if (!place || NOT_A_PLACE.has(place) || place.split(' ').length > 3) continue;
    const slug = citySlugOf(place);
    if (!slug || known.has(slug) || suggested.has(slug)) continue;
    suggested.add(slug);
    tips.push(
      `Buscan «${q.query}» (${q.impressions} veces) y no tienes página para esa zona: crea una página de zona.`,
    );
    if (suggested.size >= 2) break;
  }
  return tips.slice(0, limit);
}
