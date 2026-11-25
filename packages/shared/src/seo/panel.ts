import { daysBetween } from '../business-reminders';
import { aggregateSearchMetrics, shiftDate, type SeoTotalsDto } from '../web/search-console';

import { seoChange, type SeoChangeDto, type SeoUndetailedDto } from './metrics';

/**
 * Panel de SEO Avanzado: periodos, comparaciones (con el periodo anterior y con
 * el mismo del año pasado) y repartos «los 10 primeros y el resto». Cada
 * pantalla lee de un solo cruce: aquí solo se hacen las cuentas.
 */

/** Periodos del panel: días, meses o un rango a mano. */
export const SEO_PANEL_PERIODS = ['7d', '28d', '90d', '6m', '12m', 'custom'] as const;
export type SeoPanelPeriod = (typeof SEO_PANEL_PERIODS)[number];
export const SEO_PANEL_PERIOD_LABELS: Record<SeoPanelPeriod, string> = {
  '7d': '7 días',
  '28d': '28 días',
  '90d': '90 días',
  '6m': '6 meses',
  '12m': '12 meses',
  custom: 'Personalizado',
};
/** Un rango a mano no pasa de tres años (con los Excel importados puede haber más de 16 meses). */
export const SEO_PANEL_MAX_DAYS = 1096;

export function isSeoPanelPeriod(value: unknown): value is SeoPanelPeriod {
  return typeof value === 'string' && (SEO_PANEL_PERIODS as readonly string[]).includes(value);
}

/** Suma `months` meses a una fecha; si el día no existe, el último del mes (31 mar − 1 = 28 feb). */
export function seoShiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + months;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** El mismo día de hace `years` años (29 feb → 28 feb). */
export function seoShiftYears(date: string, years: number): string {
  return seoShiftMonths(date, years * 12);
}

export interface SeoPanelRange {
  period: SeoPanelPeriod;
  from: string;
  to: string;
  days: number;
  /** El periodo de la misma duración justo antes. */
  previousFrom: string;
  previousTo: string;
  /** Las mismas fechas del año anterior. */
  yearAgoFrom: string;
  yearAgoTo: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: string | undefined | null): v is string =>
  !!v && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/**
 * Fechas del periodo. Los de días acaban en el último día con datos; los de
 * meses, también (6 meses = del día siguiente a hace 6 meses hasta ese día).
 * El personalizado se ordena, no pasa del último día con datos ni de
 * `SEO_PANEL_MAX_DAYS`. null si el rango a mano no es válido.
 */
export function seoPanelRange(input: {
  period: SeoPanelPeriod;
  lastDate: string;
  from?: string | null;
  to?: string | null;
}): SeoPanelRange | null {
  const { period, lastDate } = input;
  let from: string;
  let to = lastDate;
  switch (period) {
    case '7d':
    case '28d':
    case '90d':
      from = shiftDate(to, -(Number.parseInt(period, 10) - 1));
      break;
    case '6m':
    case '12m':
      from = shiftDate(seoShiftMonths(to, -Number.parseInt(period, 10)), 1);
      break;
    case 'custom': {
      if (!validDate(input.from) || !validDate(input.to)) return null;
      [from, to] = input.from <= input.to ? [input.from, input.to] : [input.to, input.from];
      if (to > lastDate) to = lastDate;
      if (from > to) from = to;
      if (daysBetween(from, to) + 1 > SEO_PANEL_MAX_DAYS) {
        from = shiftDate(to, -(SEO_PANEL_MAX_DAYS - 1));
      }
      break;
    }
  }
  const days = daysBetween(from, to) + 1;
  const previousTo = shiftDate(from, -1);
  const previousFrom = shiftDate(previousTo, -(days - 1));
  return {
    period,
    from,
    to,
    days,
    previousFrom,
    previousTo,
    yearAgoFrom: seoShiftYears(from, -1),
    yearAgoTo: seoShiftYears(to, -1),
  };
}

/** Sumas que hace la base de datos para un grupo de filas de un cruce. */
export interface SeoMetricSums {
  clicks: number;
  impressions: number;
  /** Σ posición × impresiones. */
  weightedPosition: number;
  /** Σ posición (para cuando no hay impresiones). */
  positionSum: number;
  /** Filas sumadas. */
  rows: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Totales desde las sumas: lo mismo que `aggregateSearchMetrics` (CTR = clics
 * ÷ impresiones, posición ponderada por impresiones) sin traer las filas.
 */
export function seoTotalsFromSums(s: SeoMetricSums): SeoTotalsDto {
  return {
    clicks: s.clicks,
    impressions: s.impressions,
    position:
      s.rows === 0
        ? null
        : round1(s.impressions > 0 ? s.weightedPosition / s.impressions : s.positionSum / s.rows),
    ctr: s.impressions > 0 ? Math.round((s.clicks / s.impressions) * 1000) / 1000 : null,
  };
}

/**
 * Parte mínima de los días de un periodo que tienen que tener datos para compararlo
 * (Google no da los días sin impresiones, así que no se exige el 100 %).
 */
export const SEO_MIN_PERIOD_COVERAGE = 0.9;

/** Si un periodo tiene datos de casi todos sus días (y empieza después del primer dato). */
export function seoPeriodCovered(input: {
  firstDate: string | null;
  from: string;
  to: string;
  daysWithData: number;
}): boolean {
  if (!input.firstDate || input.firstDate > input.from) return false;
  const total =
    Math.round(
      (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  return total > 0 && input.daysWithData >= Math.ceil(total * SEO_MIN_PERIOD_COVERAGE);
}

/** Dos periodos que empiezan con un día de diferencia como mucho (12 meses: el anterior es el del año pasado). */
export function seoSameWindow(aFrom: string, bFrom: string): boolean {
  return (
    Math.abs(Date.parse(`${aFrom}T00:00:00Z`) - Date.parse(`${bFrom}T00:00:00Z`)) <= 86_400_000
  );
}

/** Comparación con otro periodo: si no hay datos de casi todo ese periodo, no se compara. */
export function seoComparison(
  current: SeoTotalsDto,
  other: SeoTotalsDto,
  available: boolean,
): { totals: SeoTotalsDto | null; change: SeoChangeDto | null } {
  return available
    ? { totals: other, change: seoChange(current, other) }
    : { totals: null, change: null };
}

export interface SeoShareRow {
  key: string;
  totals: SeoTotalsDto;
  /** Parte de los clics del total (0–1). */
  clickShare: number | null;
}

/**
 * Los `n` primeros por clics (y por impresiones si empatan) y el resto sumado,
 * con su parte de los clics del total que se pasa (el del cruce `site`).
 */
export function seoTopN(
  rows: readonly { key: string; clicks: number; impressions: number; position: number }[],
  n: number,
  totalClicks: number,
): { top: SeoShareRow[]; rest: (SeoShareRow & { count: number }) | null } {
  const sorted = [...rows].sort(
    (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key),
  );
  const share = (clicks: number) =>
    totalClicks > 0 ? Math.round((clicks / totalClicks) * 1000) / 1000 : null;
  const toRow = (r: (typeof sorted)[number]): SeoShareRow => {
    const totals = aggregateSearchMetrics([r]);
    return { key: r.key, totals, clickShare: share(totals.clicks) };
  };
  const top = sorted.slice(0, n).map(toRow);
  const others = sorted.slice(n);
  if (others.length === 0) return { top, rest: null };
  const totals = aggregateSearchMetrics(others);
  return {
    top,
    rest: { key: 'rest', totals, clickShare: share(totals.clicks), count: others.length },
  };
}

/** Variación de una fila (búsqueda o página) frente al periodo anterior. */
export function seoRowVariation(
  current: { clicks: number; position: number | null },
  previous: { clicks: number; position: number | null } | null,
): { clicksChange: number | null; clicksPct: number | null; positionDiff: number | null } {
  if (!previous) return { clicksChange: null, clicksPct: null, positionDiff: null };
  return {
    clicksChange: current.clicks - previous.clicks,
    clicksPct:
      previous.clicks > 0
        ? Math.round(((current.clicks - previous.clicks) / previous.clicks) * 1000) / 10
        : null,
    positionDiff:
      current.position !== null && previous.position !== null
        ? round1(previous.position - current.position)
        : null,
  };
}

// --------------------------------------------------------------- DTO del panel

export type SeoDataSource = 'api' | 'import';

export interface SeoDashboardDayDto {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  /** De dónde viene el día: la API o un Excel importado. */
  source: SeoDataSource;
  /** El mismo día del periodo anterior (por orden), si hay comparación. */
  previousClicks: number | null;
  previousImpressions: number | null;
}

export interface SeoDashboardDto {
  projectId: string;
  domainId: string | null;
  domain: string | null;
  period: SeoPanelPeriod;
  /** Último y primer día con datos del dominio (cruce `site`). */
  lastDate: string | null;
  firstDate: string | null;
  from: string;
  to: string;
  days: number;
  previousFrom: string;
  previousTo: string;
  yearAgoFrom: string;
  yearAgoTo: string;
  current: SeoTotalsDto;
  /** null si no hay datos de todo el periodo anterior. */
  previous: SeoTotalsDto | null;
  previousChange: SeoChangeDto | null;
  /** null si no hay datos de todo el mismo periodo del año anterior. */
  yearAgo: SeoTotalsDto | null;
  yearAgoChange: SeoChangeDto | null;
  daily: SeoDashboardDayDto[];
  /** Días del periodo que vienen de un Excel importado. */
  importedDays: number;
  devices: SeoShareRow[];
  countries: SeoShareRow[];
  /** El resto de países, sumados. */
  countriesRest: (SeoShareRow & { count: number }) | null;
  /** Tipos de búsqueda con impresiones (web, imágenes…). */
  searchTypes: SeoShareRow[];
  undetailed: SeoUndetailedDto | null;
  /** El resto de dominios del proyecto en el mismo periodo (sin sumarlos). */
  otherDomains: {
    domainId: string;
    domain: string;
    role: string;
    clicks: number;
    impressions: number;
  }[];
  dataDelayDays: number | null;
  delayed: boolean;
}

export const SEO_TABLE_SORTS = ['clicks', 'impressions', 'ctr', 'position', 'change'] as const;
export type SeoTableSort = (typeof SEO_TABLE_SORTS)[number];
export const SEO_TABLE_PAGE_SIZE = 50;
/** Filas como mucho en el CSV de búsquedas o páginas. */
export const SEO_TABLE_CSV_MAX = 10_000;

export interface SeoTableRowDto {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  previousClicks: number | null;
  previousImpressions: number | null;
  previousPosition: number | null;
  clicksChange: number | null;
  clicksPct: number | null;
  /** Puestos que sube (positivo = mejor). */
  positionDiff: number | null;
}

export interface SeoTablePageDto {
  dimension: 'query' | 'page';
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  /** Hay datos de todo el periodo anterior (si no, sin variación). */
  previousAvailable: boolean;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  items: SeoTableRowDto[];
}

/** Cruce búsqueda → páginas o página → búsquedas (del cruce búsqueda + página). */
export interface SeoCrossDto {
  dimension: 'query' | 'page';
  value: string;
  from: string;
  to: string;
  rows: {
    key: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
  }[];
}

/** Un proyecto en la vista global del panel admin (28 días). */
export interface SeoProjectOverviewDto {
  projectId: string;
  name: string;
  tenantId: string | null;
  tenantName: string | null;
  domain: string | null;
  lastDate: string | null;
  current: SeoTotalsDto;
  previous: SeoTotalsDto | null;
  change: SeoChangeDto | null;
  delayed: boolean;
}
