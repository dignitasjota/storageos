import { aggregateSearchMetrics, shiftDate, type SeoTotalsDto } from '../web/search-console';

/**
 * Cálculos del resumen de SEO Avanzado. Las sumas usan `aggregateSearchMetrics`
 * (CTR = clics ÷ impresiones y posición ponderada por impresiones), la misma
 * que Posiciones en Google.
 */

/** Una fila guardada de un cruce: fecha y métricas (las dimensiones aparte). */
export interface SeoMetricRow {
  date: string; // YYYY-MM-DD
  clicks: number;
  impressions: number;
  position: number;
}

/** Periodo de `days` días que acaba en `lastDate` y el anterior de la misma duración. */
export interface SeoPeriodRange {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

export function seoPeriodRange(lastDate: string, days: number): SeoPeriodRange {
  const to = lastDate;
  const from = shiftDate(to, -(days - 1));
  const previousTo = shiftDate(from, -1);
  const previousFrom = shiftDate(previousTo, -(days - 1));
  return { from, to, previousFrom, previousTo };
}

/** Suma de las filas entre dos fechas (incluidas). */
export function seoTotalsBetween(rows: readonly SeoMetricRow[], from: string, to: string) {
  return aggregateSearchMetrics(rows.filter((r) => r.date >= from && r.date <= to));
}

/** Variación del periodo frente al anterior. */
export interface SeoChangeDto {
  /** % de variación (null si antes no había ninguno). */
  clicksPct: number | null;
  impressionsPct: number | null;
  /** Diferencia de CTR en puntos (0,012 = 1,2 puntos más). */
  ctrDiff: number | null;
  /** Puestos que sube (positivo = mejor posición). */
  positionDiff: number | null;
}

const pct = (now: number, before: number): number | null =>
  before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null;

export function seoChange(current: SeoTotalsDto, previous: SeoTotalsDto): SeoChangeDto {
  return {
    clicksPct: pct(current.clicks, previous.clicks),
    impressionsPct: pct(current.impressions, previous.impressions),
    ctrDiff:
      current.ctr !== null && previous.ctr !== null
        ? Math.round((current.ctr - previous.ctr) * 1000) / 1000
        : null,
    positionDiff:
      current.position !== null && previous.position !== null
        ? Math.round((previous.position - current.position) * 10) / 10
        : null,
  };
}

/** Búsquedas que Google no detalla (poco frecuentes o anónimas). */
export interface SeoUndetailedDto {
  clicks: number;
  impressions: number;
  /** Parte de las impresiones del sitio (0–1). */
  impressionsShare: number | null;
}

/**
 * Total del sitio (cruce `site`) menos la suma del cruce `query` del mismo
 * periodo. Nunca negativo (Google redondea por separado cada cruce).
 */
export function undetailedSearches(site: SeoTotalsDto, byQuery: SeoTotalsDto): SeoUndetailedDto {
  const clicks = Math.max(0, site.clicks - byQuery.clicks);
  const impressions = Math.max(0, site.impressions - byQuery.impressions);
  return {
    clicks,
    impressions,
    impressionsShare:
      site.impressions > 0 ? Math.round((impressions / site.impressions) * 1000) / 1000 : null,
  };
}

/**
 * Resumen del periodo desde el cruce `site` (los totales que cuadran con
 * Google), su reparto por dispositivo y lo que no se detalla por búsqueda.
 * `firstDate` es el primer día con datos: si no cubre el periodo anterior
 * entero, no se compara.
 */
export function summarizeSeoSite(input: {
  days: number;
  site: readonly SeoMetricRow[];
  devices: readonly (SeoMetricRow & { device: string })[];
  /** Suma del cruce `query` en el periodo actual (null si no se descargó). */
  queryTotals: SeoTotalsDto | null;
  /**
   * Primer y último día con datos de todo el histórico (si solo se pasan las
   * filas de los dos periodos). Google no da los días sin impresiones.
   */
  firstDate?: string | null;
  lastDate?: string | null;
}) {
  const dates = input.site.map((r) => r.date).sort();
  const lastDate = input.lastDate ?? (dates.length > 0 ? dates[dates.length - 1]! : null);
  const firstDate = input.firstDate ?? (dates.length > 0 ? dates[0]! : null);
  const range = seoPeriodRange(lastDate ?? new Date().toISOString().slice(0, 10), input.days);
  const current = seoTotalsBetween(input.site, range.from, range.to);
  const previousComplete = firstDate !== null && firstDate <= range.previousFrom;
  const previous = previousComplete
    ? seoTotalsBetween(input.site, range.previousFrom, range.previousTo)
    : null;
  const byDevice = new Map<string, SeoMetricRow[]>();
  for (const r of input.devices) {
    if (r.date < range.from || r.date > range.to) continue;
    const list = byDevice.get(r.device) ?? [];
    list.push(r);
    byDevice.set(r.device, list);
  }
  const devices = [...byDevice.entries()]
    .map(([device, rows]) => {
      const totals = aggregateSearchMetrics(rows);
      return {
        device,
        totals,
        clickShare:
          current.clicks > 0 ? Math.round((totals.clicks / current.clicks) * 1000) / 1000 : null,
      };
    })
    .sort(
      (a, b) => b.totals.clicks - a.totals.clicks || b.totals.impressions - a.totals.impressions,
    );
  const daily = input.site
    .filter((r) => r.date >= range.from && r.date <= range.to)
    .map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    lastDate,
    ...range,
    current,
    previous,
    change: previous ? seoChange(current, previous) : null,
    devices,
    undetailed:
      input.queryTotals && lastDate ? undetailedSearches(current, input.queryTotals) : null,
    daily,
  };
}
