import type { SeoTotalsDto } from '../web/search-console';

/**
 * Importación de los Excel (o zip de CSV) que exporta Search Console, en
 * español o en inglés. Lo que viene en cada pestaña:
 *
 * - «Fechas»: los totales de cada día. Entra en el cruce `site` solo en los
 *   días que la API no tiene.
 * - Consultas, Páginas, Países, Dispositivos y Aspecto en las búsquedas: sumas
 *   de todo el periodo exportado. Se guardan como foto del periodo y nunca se
 *   reparten por días ni se suman a los datos diarios.
 * - «Filtros»: con qué filtros se exportó. Con uno de país, dispositivo,
 *   búsqueda, página o un tipo de búsqueda que no sea la web, el Excel no es el
 *   total del sitio.
 *
 * Aquí solo se interpreta el contenido ya leído (filas de texto); leer el
 * fichero lo hace el API.
 */

export const SEO_IMPORT_DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'search_appearance',
  'date',
] as const;
export type SeoImportDimension = (typeof SEO_IMPORT_DIMENSIONS)[number];
export const SEO_IMPORT_DIMENSION_LABELS: Record<SeoImportDimension, string> = {
  query: 'Consultas',
  page: 'Páginas',
  country: 'Países',
  device: 'Dispositivos',
  search_appearance: 'Aspecto en las búsquedas',
  date: 'Fechas',
};

/** Tamaño máximo del fichero que se sube. */
export const SEO_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
/** Filas como mucho por pestaña (Google exporta 1.000). */
export const SEO_IMPORT_MAX_ROWS_PER_TAB = 50_000;

export type SeoImportLanguage = 'es' | 'en';
export type SeoImportFormat = 'xlsx' | 'zip';

/** Una pestaña (o un CSV del zip) leída como texto. */
export interface SeoImportSheet {
  name: string;
  rows: string[][];
}

export interface SeoImportRowInput {
  value: string;
  clicks: number;
  impressions: number;
  /** El CTR y la posición del Excel (0–1 y puestos), solo como referencia. */
  ctr: number | null;
  position: number | null;
}

export interface SeoImportFilter {
  name: string;
  value: string;
}

export interface ParsedGscExport {
  language: SeoImportLanguage;
  periodFrom: string;
  periodTo: string;
  /** Las pestañas con datos, incluida «Fechas» (valor = YYYY-MM-DD). */
  tabs: { dimension: SeoImportDimension; rows: SeoImportRowInput[] }[];
  filters: SeoImportFilter[];
  /** No es el total del sitio: no entra en el cruce `site`. */
  filtered: boolean;
  filterReasons: string[];
  warnings: string[];
}

/** Sin acentos, en minúsculas, sin `.csv` ni espacios de más. */
export function normalizeGscLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.csv$/, '')
    .replace(/^.*\//, '')
    .replace(/[_\s]+/g, ' ')
    .trim();
}

const TAB_ALIASES: Record<SeoImportDimension | 'filters', { es: string[]; en: string[] }> = {
  query: {
    es: ['consultas', 'consultas principales', 'consulta'],
    en: ['queries', 'top queries', 'query'],
  },
  page: {
    es: ['paginas', 'paginas principales', 'pagina'],
    en: ['pages', 'top pages', 'page'],
  },
  country: { es: ['paises', 'pais'], en: ['countries', 'country'] },
  device: { es: ['dispositivos', 'dispositivo'], en: ['devices', 'device'] },
  search_appearance: {
    es: [
      'aspecto en las busquedas',
      'aspecto en la busqueda',
      'aspecto de la busqueda',
      'aspecto en los resultados de busqueda',
      'apariencia en las busquedas',
      'apariencia en la busqueda',
    ],
    en: ['search appearance', 'search appearances'],
  },
  date: { es: ['fechas', 'fecha'], en: ['dates', 'date'] },
  filters: { es: ['filtros', 'filtro'], en: ['filters', 'filter'] },
};

/** Qué pestaña es (por su nombre y, si no, por la primera cabecera). */
export function detectGscTab(
  name: string,
  header: readonly string[],
): { tab: SeoImportDimension | 'filters'; language: SeoImportLanguage } | null {
  for (const candidate of [name, header[0] ?? '']) {
    const label = normalizeGscLabel(candidate);
    if (!label) continue;
    for (const [tab, aliases] of Object.entries(TAB_ALIASES) as [
      SeoImportDimension | 'filters',
      { es: string[]; en: string[] },
    ][]) {
      if (aliases.es.includes(label)) return { tab, language: 'es' };
      if (aliases.en.includes(label)) return { tab, language: 'en' };
    }
  }
  return null;
}

/** Entero de un número del Excel («1234», «1.234», «1,234»). */
export function parseGscInt(value: string | undefined): number | null {
  const v = (value ?? '').replace(/[\s\u00a0.,']/g, '');
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Decimal con punto o coma («8.5», «8,5»). */
export function parseGscDecimal(value: string | undefined): number | null {
  let v = (value ?? '').replace(/[\s\u00a0]/g, '');
  if (!v) return null;
  if (v.includes(',') && !v.includes('.')) v = v.replace(',', '.');
  else v = v.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** CTR: «3,45 %», «3.45%» o la fracción 0.0345 → 0.0345. */
export function parseGscCtr(value: string | undefined): number | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const isPct = raw.includes('%');
  const n = parseGscDecimal(raw.replace('%', ''));
  if (n === null) return null;
  const fraction = isPct || n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, Math.round(fraction * 1_000_000) / 1_000_000));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Fecha del Excel: «2025-03-31», «31/03/2025» o el número de serie de Excel. */
export function parseGscDate(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if (/^\d{5}$/.test(v)) {
    // Número de serie de Excel (días desde el 30-12-1899).
    const date = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86_400_000);
    return date.toISOString().slice(0, 10);
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Dispositivo con el código de la API (MOBILE, DESKTOP, TABLET). */
export function normalizeGscDevice(value: string): string {
  const v = normalizeGscLabel(value);
  if (['movil', 'mobile', 'telefono movil'].includes(v)) return 'MOBILE';
  if (['ordenador', 'desktop', 'escritorio', 'computer'].includes(v)) return 'DESKTOP';
  if (['tablet', 'tableta'].includes(v)) return 'TABLET';
  return value.trim();
}

const DATE_FILTERS = ['fecha', 'date', 'periodo', 'period', 'intervalo de fechas', 'date range'];
const SEARCH_TYPE_FILTERS = ['tipo de busqueda', 'search type', 'tipo'];
const WEB = ['web'];

/**
 * ¿El Excel es el total del sitio? Solo si sus filtros son la fecha y, como
 * mucho, el tipo de búsqueda «Web» (lo que guarda la API en el cruce `site`).
 */
export function analyzeGscFilters(filters: readonly SeoImportFilter[]): {
  filtered: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const f of filters) {
    const name = normalizeGscLabel(f.name);
    const value = normalizeGscLabel(f.value);
    if (DATE_FILTERS.includes(name)) continue;
    if (SEARCH_TYPE_FILTERS.includes(name)) {
      if (!WEB.includes(value)) {
        reasons.push(`Exportado con el tipo de búsqueda «${f.value}»: no es la búsqueda web.`);
      }
      continue;
    }
    reasons.push(`Exportado con el filtro «${f.name}: ${f.value}».`);
  }
  return { filtered: reasons.length > 0, reasons };
}

const COLUMN = {
  clicks: (h: string) => /\bclic(k)?s?\b/.test(h),
  impressions: (h: string) => /\bimpresion(es)?\b|\bimpressions?\b/.test(h),
  ctr: (h: string) => /\bctr\b/.test(h),
  position: (h: string) => /\bposicion\b|\bposition\b/.test(h),
};

type ColumnKey = keyof typeof COLUMN;

/** Error de contenido: el fichero no se puede importar (con el porqué). */
export class GscImportError extends Error {}

function columnsOf(header: readonly string[], tab: string) {
  const norm = header.map(normalizeGscLabel);
  const cols: Partial<Record<ColumnKey, number>> = {};
  for (const key of Object.keys(COLUMN) as ColumnKey[]) {
    const matches = norm.map((h, i) => (i > 0 && COLUMN[key](h) ? i : -1)).filter((i) => i >= 0);
    if (matches.length > 1) {
      throw new GscImportError(
        `La pestaña ${tab} compara dos periodos. Exporta desde Search Console un solo periodo, sin comparar.`,
      );
    }
    if (matches[0] !== undefined) cols[key] = matches[0];
  }
  // Sin cabeceras reconocibles, el orden de Google: valor, clics, impresiones, CTR, posición.
  if (cols.clicks === undefined && cols.impressions === undefined) {
    return { clicks: 1, impressions: 2, ctr: 3, position: 4 } as Record<ColumnKey, number>;
  }
  if (cols.clicks === undefined || cols.impressions === undefined) {
    throw new GscImportError(`La pestaña ${tab} no tiene las columnas de clics e impresiones.`);
  }
  return cols;
}

const isHeaderRow = (row: readonly string[]) =>
  row.slice(1).some((cell) => {
    const h = normalizeGscLabel(cell);
    return COLUMN.clicks(h) || COLUMN.impressions(h);
  });

/**
 * Interpreta las pestañas de una exportación de Search Console. Lanza
 * `GscImportError` con un mensaje claro si no es una exportación válida.
 */
export function parseGscExport(sheets: readonly SeoImportSheet[]): ParsedGscExport {
  const tabs = new Map<SeoImportDimension, SeoImportRowInput[]>();
  const filters: SeoImportFilter[] = [];
  const warnings: string[] = [];
  const languages = { es: 0, en: 0 };
  for (const sheet of sheets) {
    const rows = sheet.rows.filter((r) => r.some((c) => (c ?? '').trim() !== ''));
    if (rows.length === 0) continue;
    const header = rows[0]!;
    const detected = detectGscTab(sheet.name, header);
    if (!detected) {
      warnings.push(`Se ha ignorado la pestaña «${sheet.name}»: no es de Search Console.`);
      continue;
    }
    languages[detected.language]++;
    if (detected.tab === 'filters') {
      const body = rows.slice(
        ['filtro', 'filter'].includes(normalizeGscLabel(header[0] ?? '')) ? 1 : 0,
      );
      for (const r of body) {
        const name = (r[0] ?? '').trim();
        if (name) filters.push({ name, value: (r[1] ?? '').trim() });
      }
      continue;
    }
    const dimension = detected.tab;
    if (tabs.has(dimension)) {
      throw new GscImportError(
        `El fichero trae dos veces la pestaña ${SEO_IMPORT_DIMENSION_LABELS[dimension]}.`,
      );
    }
    const label = SEO_IMPORT_DIMENSION_LABELS[dimension];
    const hasHeader = isHeaderRow(header);
    const cols = hasHeader
      ? columnsOf(header, label)
      : ({ clicks: 1, impressions: 2, ctr: 3, position: 4 } as Partial<Record<ColumnKey, number>>);
    const body = hasHeader ? rows.slice(1) : rows;
    if (body.length > SEO_IMPORT_MAX_ROWS_PER_TAB) {
      throw new GscImportError(
        `La pestaña ${label} tiene demasiadas filas (más de ${SEO_IMPORT_MAX_ROWS_PER_TAB}).`,
      );
    }
    const parsed: SeoImportRowInput[] = [];
    const seen = new Set<string>();
    let invalid = 0;
    for (const r of body) {
      let value = (r[0] ?? '').trim();
      const clicks = parseGscInt(r[cols.clicks!]);
      const impressions = parseGscInt(r[cols.impressions!]);
      if (!value || clicks === null || impressions === null) {
        invalid++;
        continue;
      }
      if (dimension === 'date') {
        const date = parseGscDate(value);
        if (!date) {
          invalid++;
          continue;
        }
        value = date;
      } else if (dimension === 'device') {
        value = normalizeGscDevice(value);
      }
      if (seen.has(value)) {
        if (dimension === 'date') {
          throw new GscImportError(`El día ${value} aparece dos veces en la pestaña Fechas.`);
        }
        invalid++;
        continue;
      }
      seen.add(value);
      parsed.push({
        value: value.slice(0, 2000),
        clicks,
        impressions,
        ctr: cols.ctr === undefined ? null : parseGscCtr(r[cols.ctr]),
        position: cols.position === undefined ? null : parseGscDecimal(r[cols.position]),
      });
    }
    if (invalid > 0) {
      warnings.push(
        `Se han saltado ${invalid} ${invalid === 1 ? 'fila' : 'filas'} de la pestaña ${label} sin datos válidos.`,
      );
    }
    tabs.set(dimension, parsed);
  }
  const dates = tabs.get('date');
  if (!dates || dates.length === 0) {
    if (tabs.size === 0) {
      throw new GscImportError(
        'No parece una exportación de Search Console: no hay pestañas de Consultas, Páginas, Países, Dispositivos ni Fechas.',
      );
    }
    throw new GscImportError(
      'Falta la pestaña Fechas: sin ella no se sabe qué periodo cubre el fichero. Exporta el informe de rendimiento completo.',
    );
  }
  const sorted = dates.map((d) => d.value).sort();
  const { filtered, reasons } = analyzeGscFilters(filters);
  return {
    language: languages.en > languages.es ? 'en' : 'es',
    periodFrom: sorted[0]!,
    periodTo: sorted[sorted.length - 1]!,
    tabs: SEO_IMPORT_DIMENSIONS.filter((d) => tabs.has(d)).map((dimension) => ({
      dimension,
      rows: tabs.get(dimension)!,
    })),
    filters,
    filtered,
    filterReasons: reasons,
    warnings,
  };
}

// ------------------------------------------------------------------- DTO

export interface SeoImportPreviewDto {
  domainId: string;
  domain: string;
  fileName: string;
  fileHash: string;
  format: SeoImportFormat;
  language: SeoImportLanguage;
  periodFrom: string;
  periodTo: string;
  filters: SeoImportFilter[];
  filtered: boolean;
  filterReasons: string[];
  warnings: string[];
  tabRows: Partial<Record<SeoImportDimension, number>>;
  /** Días de la pestaña Fechas que ya tiene la API (mandan los suyos). */
  siteDaysApi: number;
  /** Días que ya vienen de otra importación. */
  siteDaysImported: number;
  /** Días que se añadirán al cruce del sitio. */
  siteDaysToAdd: number;
}

export interface SeoImportDto {
  id: string;
  domainId: string;
  domain: string;
  fileName: string;
  format: SeoImportFormat;
  language: SeoImportLanguage;
  periodFrom: string;
  periodTo: string;
  filters: SeoImportFilter[];
  filtered: boolean;
  tabRows: Partial<Record<SeoImportDimension, number>>;
  siteDaysAdded: number;
  siteDaysApi: number;
  siteDaysImported: number;
  createdAt: string;
  createdBy: string | null;
}

export interface SeoImportTabDto {
  dimension: SeoImportDimension;
  /** Totales recalculados (CTR = clics ÷ impresiones, posición ponderada). */
  totals: SeoTotalsDto;
  rows: {
    value: string;
    clicks: number;
    impressions: number;
    /** Recalculado con los clics y las impresiones de la fila. */
    ctr: number | null;
    /** La del Excel. */
    position: number | null;
  }[];
}

export interface SeoImportDetailDto extends SeoImportDto {
  tabs: SeoImportTabDto[];
}
