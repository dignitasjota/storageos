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

/** Lo que se sabe de la web del negocio para comprobar que el sitio es suyo. */
export interface SearchConsoleOwnSite {
  /** Identificador del negocio (su web en la plataforma es `/s/<slug>/`). */
  slug: string;
  /** Su dominio propio, solo si está verificado. */
  customDomain: string | null;
  /** Dirección de la plataforma (`https://trasteros.pro`). */
  platformUrl: string;
}

const hostOfUrl = (url: string): { host: string; path: string } | null => {
  const m = /^https?:\/\/([^/:?#]+)(?::\d+)?(\/[^?#]*)?/i.exec(url.trim());
  return m?.[1] ? { host: m[1].toLowerCase(), path: m[2] ?? '/' } : null;
};
const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');

/**
 * ¿Es este sitio de Search Console de la web del negocio? Solo su dominio
 * propio verificado (`sc-domain:` del dominio o de uno superior, o una
 * dirección de ese dominio) o su dirección en la plataforma (`/s/<slug>/`).
 * Todos los negocios dan acceso a la misma cuenta de servicio, así que sin
 * esto uno podría conectar el sitio de otro y ver sus búsquedas.
 */
export function searchConsoleSiteAllowed(siteUrl: string, site: SearchConsoleOwnSite): boolean {
  const value = siteUrl.trim().toLowerCase();
  const domain = site.customDomain ? bare(site.customDomain) : null;
  if (value.startsWith('sc-domain:')) {
    const prop = value.slice('sc-domain:'.length);
    if (!domain || !prop.includes('.')) return false;
    return domain === prop || domain.endsWith(`.${prop}`);
  }
  const url = hostOfUrl(value);
  if (!url) return false;
  if (domain && bare(url.host) === domain) return true;
  const platform = hostOfUrl(site.platformUrl);
  if (!platform || bare(url.host) !== bare(platform.host)) return false;
  const own = `/s/${site.slug.toLowerCase()}/`;
  return url.path.toLowerCase().startsWith(own);
}

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
  /** Palabras de tu marca (búsquedas de quien ya te conoce). */
  brandTerms: string[];
  /** Quién recibe el informe mensual (vacío = los propietarios). */
  reportRecipientIds: string[];
}

export const SeoMonthlyReportToggleSchema = z.object({ enabled: z.boolean() });

/** Ajustes de Posiciones en Google: marca y quién recibe el informe. */
export const UpdateSeoSettingsSchema = z.object({
  brandTerms: z.array(z.string().trim().min(2).max(60)).max(10).optional(),
  reportRecipientIds: z.array(z.string().uuid()).max(20).optional(),
});
export type UpdateSeoSettingsInput = z.infer<typeof UpdateSeoSettingsSchema>;

/** Búsqueda que se sigue, con la posición a la que se quiere llegar. */
export const CreateTrackedKeywordSchema = z.object({
  keyword: z.string().trim().min(2).max(120),
  targetPosition: z.number().int().min(1).max(100).nullable().optional(),
});
export type CreateTrackedKeywordInput = z.infer<typeof CreateTrackedKeywordSchema>;

export interface TrackedKeywordDto {
  id: string;
  keyword: string;
  targetPosition: number | null;
  /** Posición media del periodo (null si no has salido). */
  position: number | null;
  previousPosition: number | null;
  clicks: number;
  impressions: number;
  /** Ya está en la posición objetivo o mejor. */
  reached: boolean;
}

/** Totales de un día por dispositivo (MOBILE, DESKTOP, TABLET). */
export interface SearchConsoleDeviceInput extends SearchConsoleDayInput {
  device: string;
}

/** Evolución día a día de una búsqueda o una página. */
export interface SeoDetailDto {
  kind: 'query' | 'page';
  key: string;
  daily: { date: string; clicks: number; impressions: number; position: number }[];
  /** Para una búsqueda, sus páginas; para una página, sus búsquedas. */
  related: { label: string; clicks: number; impressions: number; position: number }[];
}

/** De Google a reservas en el periodo. */
export interface SeoGoogleFunnelDto {
  from: string;
  to: string;
  /** Clics en Google (Search Console). */
  googleClicks: number;
  /** Visitantes que llegan desde Google sin anuncios (analítica de la web). */
  visitors: number;
  /** Contactos que llegaron así. */
  contacts: number;
  /** Reservas y contratos firmados de esos contactos. */
  bookings: number;
  /** Página por la que entraron. */
  pages: { path: string; visitors: number }[];
}

/** Fila guardada (lo que devuelve Search Console por día, búsqueda y página). */
export interface SearchConsoleRowInput {
  date: string; // YYYY-MM-DD
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Totales de un día tal como los da Search Console (cuadran con su panel). */
export interface SearchConsoleDayInput {
  date: string; // YYYY-MM-DD
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
  /** Primer día descargado: si es posterior a `previousFrom`, el anterior está incompleto. */
  firstDate: string | null;
  /** El periodo anterior tiene todos sus días descargados (si no, no se compara). */
  previousComplete: boolean;
  /** Clics, apariciones y posición de cada semana del periodo (lunes a domingo). */
  weekly: { week: string; clicks: number; impressions: number; position: number | null }[];
  /** Búsquedas con tu marca frente a las demás (con las búsquedas detalladas). */
  brand: {
    terms: string[];
    brandClicks: number;
    brandImpressions: number;
    genericClicks: number;
    genericImpressions: number;
  };
  /** Por dispositivo (si ya se han descargado). */
  devices: {
    device: string;
    clicks: number;
    impressions: number;
    position: number | null;
    ctr: number | null;
  }[];
  /** Los mismos días del año pasado (si se descargaron enteros). */
  yearAgoTotals: SeoTotalsDto | null;
  /**
   * Páginas que salen mucho en Google y apenas reciben clics para su posición:
   * su título o descripción no anima a entrar.
   */
  lowCtrPages: {
    page: string;
    path: string;
    areaSlug: string | null;
    impressions: number;
    clicks: number;
    ctr: number;
    expectedCtr: number;
    position: number;
  }[];
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

/**
 * Suma de filas de Search Console: CTR = clics ÷ impresiones (nunca la media
 * de los CTR) y posición media ponderada por impresiones (sin impresiones, la
 * media simple). Lo usan Posiciones en Google y SEO Avanzado.
 */
export function aggregateSearchMetrics(
  rows: readonly { clicks: number; impressions: number; position: number }[],
): SeoTotalsDto {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  let positionSum = 0;
  for (const d of rows) {
    clicks += d.clicks;
    impressions += d.impressions;
    weighted += d.position * d.impressions;
    positionSum += d.position;
  }
  return {
    clicks,
    impressions,
    position:
      rows.length === 0
        ? null
        : round1(impressions > 0 ? weighted / impressions : positionSum / rows.length),
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 1000) / 1000 : null,
  };
}

/** Totales con los de cada día de Google (cuadran con su panel). */
function totalsOfDays(days: SearchConsoleDayInput[]): SeoTotalsDto {
  return aggregateSearchMetrics(days);
}

function totalsOf(rows: SearchConsoleRowInput[]): SeoTotalsDto {
  return aggregateSearchMetrics(rows);
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
  opts: {
    days?: SearchConsoleDayInput[];
    firstDate?: string | null;
    brandTerms?: string[];
    devices?: SearchConsoleDeviceInput[];
  } = {},
): SeoPositionsDto {
  const dated = [...rows.map((r) => r.date), ...(opts.days ?? []).map((d) => d.date)];
  const lastDate = dated.reduce<string | null>((m, d) => (!m || d > m ? d : m), null);
  const to = lastDate ?? new Date().toISOString().slice(0, 10);
  const from = shiftDate(to, -(days - 1));
  const previousTo = shiftDate(from, -1);
  const previousFrom = shiftDate(previousTo, -(days - 1));
  return summarizeRange(rows, { from, to, previousFrom, previousTo }, lastDate, opts);
}

/** Primer y último día del mes natural anterior a `date` (YYYY-MM-DD). */
export function previousMonthRange(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(y, m - 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** Porcentaje de clics habitual en Google según la posición (aproximado). */
export function expectedCtr(position: number): number {
  if (position < 1.5) return 0.28;
  if (position < 2.5) return 0.15;
  if (position < 3.5) return 0.11;
  if (position < 4.5) return 0.08;
  if (position < 5.5) return 0.06;
  if (position <= 10) return 0.03;
  return 0.01;
}

/** ¿Es una búsqueda con la marca? (contiene alguna de sus palabras). */
export function isBrandQuery(query: string, terms: string[]): boolean {
  const q = query.toLowerCase();
  return terms.some((t) => t.trim().length >= 2 && q.includes(t.trim().toLowerCase()));
}

/** Lunes de la semana de una fecha `YYYY-MM-DD`. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Resumen de un rango concreto frente a otro (p. ej. un mes frente al anterior). */
export function summarizeRange(
  rows: SearchConsoleRowInput[],
  range: { from: string; to: string; previousFrom: string; previousTo: string },
  lastDate: string | null = null,
  opts: {
    days?: SearchConsoleDayInput[];
    firstDate?: string | null;
    brandTerms?: string[];
    devices?: SearchConsoleDeviceInput[];
  } = {},
): SeoPositionsDto {
  const { from, to, previousFrom, previousTo } = range;
  const current = rows.filter((r) => r.date >= from && r.date <= to);
  const previous = rows.filter((r) => r.date >= previousFrom && r.date <= previousTo);
  // Con los totales de cada día de Google, los totales cuadran con su panel
  // (las filas por búsqueda no traen las búsquedas poco frecuentes).
  const days = opts.days ?? [];
  const totals = (list: SearchConsoleRowInput[], a: string, b: string) => {
    const inRange = days.filter((d) => d.date >= a && d.date <= b);
    return inRange.length > 0 ? totalsOfDays(inRange) : totalsOf(list);
  };
  const firstDate =
    opts.firstDate ??
    [...rows.map((r) => r.date), ...days.map((d) => d.date)].reduce<string | null>(
      (m, d) => (!m || d < m ? d : m),
      null,
    );
  const previousComplete = firstDate !== null && firstDate <= previousFrom;

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
  // Sin el periodo anterior completo no hay con qué comparar.
  for (const p of previousComplete ? pages : []) {
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
  for (const q of previousComplete ? queries.slice(0, 20) : []) {
    if (q.change != null && q.change <= -3 && q.impressions >= 20) {
      alerts.push({
        kind: 'query_dropped',
        label: q.query,
        detail: `Ha bajado de la posición ${q.previousPosition} a la ${q.position}.`,
      });
    }
  }

  // Semanas del periodo: con los totales de Google si los hay.
  const weeks = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  const dayList = days.filter((d) => d.date >= from && d.date <= to);
  const weekSource: SearchConsoleDayInput[] =
    dayList.length > 0
      ? dayList
      : current.map((r) => ({
          date: r.date,
          clicks: r.clicks,
          impressions: r.impressions,
          position: r.position,
        }));
  for (const d of weekSource) {
    const key = weekStart(d.date);
    const w = weeks.get(key) ?? { clicks: 0, impressions: 0, weighted: 0 };
    w.clicks += d.clicks;
    w.impressions += d.impressions;
    w.weighted += d.position * d.impressions;
    weeks.set(key, w);
  }
  const weekly = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, w]) => ({
      week,
      clicks: w.clicks,
      impressions: w.impressions,
      position: w.impressions > 0 ? round1(w.weighted / w.impressions) : null,
    }));

  const terms = (opts.brandTerms ?? []).filter((t) => t.trim().length >= 2);
  const brand = {
    terms,
    brandClicks: 0,
    brandImpressions: 0,
    genericClicks: 0,
    genericImpressions: 0,
  };
  for (const r of current) {
    if (terms.length > 0 && isBrandQuery(r.query, terms)) {
      brand.brandClicks += r.clicks;
      brand.brandImpressions += r.impressions;
    } else {
      brand.genericClicks += r.clicks;
      brand.genericImpressions += r.impressions;
    }
  }

  const byDevice = new Map<string, SearchConsoleDayInput[]>();
  for (const d of (opts.devices ?? []).filter((x) => x.date >= from && x.date <= to)) {
    byDevice.set(d.device, [...(byDevice.get(d.device) ?? []), d]);
  }
  const devices = [...byDevice.entries()]
    .map(([device, list]) => ({ device, ...totalsOfDays(list) }))
    .sort((a, b) => b.clicks - a.clicks);

  // El mismo tramo del año pasado (364 días: misma semana), si está entero.
  const yaFrom = shiftDate(from, -364);
  const yaTo = shiftDate(to, -364);
  const yearAgoComplete = firstDate !== null && firstDate <= yaFrom;
  const yearAgoDays = days.filter((d) => d.date >= yaFrom && d.date <= yaTo);
  const yearAgoTotals =
    yearAgoComplete && yearAgoDays.length > 0 ? totalsOfDays(yearAgoDays) : null;

  const lowCtrPages = pages
    .filter((p) => p.impressions >= 100 && p.position <= 10)
    .map((p) => ({
      page: p.page,
      path: p.path,
      areaSlug: p.areaSlug,
      impressions: p.impressions,
      clicks: p.clicks,
      ctr: Math.round((p.clicks / p.impressions) * 1000) / 1000,
      expectedCtr: expectedCtr(p.position),
      position: p.position,
    }))
    .filter((p) => p.ctr < p.expectedCtr * 0.5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5);

  return {
    from,
    to,
    previousFrom,
    previousTo,
    weekly,
    brand,
    devices,
    yearAgoTotals,
    lowCtrPages,
    totals: totals(current, from, to),
    previousTotals: totals(previous, previousFrom, previousTo),
    queries: queries.slice(0, 200),
    opportunities,
    pages,
    alerts: alerts.slice(0, 10),
    lastDate,
    firstDate,
    previousComplete,
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
