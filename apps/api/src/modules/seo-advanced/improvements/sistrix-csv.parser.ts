import {
  SEO_SISTRIX_CSV_MAX_ROWS,
  normalizeSeoDomain,
  normalizeSeoKeyword,
  seoPlainText,
  type SeoSistrixCsvKind,
} from '@storageos/shared';
import Papa from 'papaparse';

/** Nombres de columna (sin tildes ni mayúsculas) que se aceptan, en español, inglés y alemán. */
const ALIASES = {
  keyword: ['keyword', 'keywords', 'palabra clave', 'palabra', 'suchbegriff', 'busqueda', 'query'],
  position: ['position', 'posicion', 'pos', 'pos.', 'rank', 'ranking', 'platz', 'puesto'],
  url: ['url', 'landing page', 'landingpage', 'pagina', 'pagina de destino', 'ranking url'],
  domain: ['domain', 'dominio', 'host', 'competidor', 'competitor', 'competitors', 'wettbewerber'],
  title: ['title', 'titulo', 'titel'],
} as const;
type Field = keyof typeof ALIASES;

export interface ParsedCsv<T> {
  rows: T[];
  /** Filas que no valen (sin dato o sin posición). */
  skipped: number;
  warnings: string[];
}

export interface KeywordCsvRow {
  keyword: string;
  position: number;
  url: string;
}
export interface SerpCsvRow {
  position: number;
  domain: string;
  url: string;
  title: string | null;
}
export interface CompetitorCsvRow {
  domain: string;
}

/** Quita el BOM y, si el separador no es la coma, lo detecta. */
export function sniffDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: [string, number][] = [';', ',', '\t'].map((d) => [d, first.split(d).length - 1]);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

function readTable(text: string): { headers: string[]; records: Record<string, string>[] } {
  const clean = text.replace(/^\uFEFF/, '');
  const res = Papa.parse<Record<string, string>>(clean, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: sniffDelimiter(clean),
    transformHeader: (h) => seoPlainText(h),
  });
  return { headers: res.meta.fields ?? [], records: res.data };
}

function columnFor(headers: string[], field: Field): string | null {
  const wanted = new Set<string>(ALIASES[field].map(seoPlainText));
  return headers.find((h) => wanted.has(h)) ?? null;
}

const toInt = (v: string | undefined): number | null => {
  const n = Number.parseInt((v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class SistrixCsvError extends Error {}

function guardSize(records: unknown[]): void {
  if (records.length > SEO_SISTRIX_CSV_MAX_ROWS) {
    throw new SistrixCsvError(
      `El fichero tiene más de ${SEO_SISTRIX_CSV_MAX_ROWS} filas: divídelo y súbelo por partes.`,
    );
  }
}

/** Palabras de un dominio: palabra, posición y URL. */
export function parseDomainKeywordsCsv(text: string): ParsedCsv<KeywordCsvRow> {
  const { headers, records } = readTable(text);
  guardSize(records);
  const kw = columnFor(headers, 'keyword');
  const pos = columnFor(headers, 'position');
  if (!kw || !pos) {
    throw new SistrixCsvError(
      'No encuentro las columnas de la palabra y la posición. Exporta de SISTRIX «Palabras» del dominio (Keyword y Position).',
    );
  }
  const url = columnFor(headers, 'url');
  const seen = new Set<string>();
  const rows: KeywordCsvRow[] = [];
  let skipped = 0;
  for (const r of records) {
    const keyword = normalizeSeoKeyword(r[kw] ?? '');
    const position = toInt(r[pos]);
    if (keyword.length < 2 || keyword.length > 200 || position === null || seen.has(keyword)) {
      skipped++;
      continue;
    }
    seen.add(keyword);
    rows.push({ keyword, position, url: (url ? (r[url] ?? '') : '').trim().slice(0, 2000) });
  }
  return { rows, skipped, warnings: url ? [] : ['No hay columna de URL: se guardan sin ella.'] };
}

/** Resultados de Google de una búsqueda: posición, dominio, URL y (si hay) título. */
export function parseSerpCsv(text: string): ParsedCsv<SerpCsvRow> {
  const { headers, records } = readTable(text);
  guardSize(records);
  const pos = columnFor(headers, 'position');
  const dom = columnFor(headers, 'domain');
  const url = columnFor(headers, 'url');
  if (!pos || (!dom && !url)) {
    throw new SistrixCsvError(
      'No encuentro las columnas de la posición y del dominio (o la URL). Exporta de SISTRIX los resultados de Google de la palabra.',
    );
  }
  const title = columnFor(headers, 'title');
  const rows: SerpCsvRow[] = [];
  let skipped = 0;
  for (const r of records) {
    const position = toInt(r[pos]);
    const rawUrl = (url ? (r[url] ?? '') : '').trim();
    const domain = normalizeSeoDomain((dom ? r[dom] : '') || rawUrl);
    if (position === null || position > 100 || !domain) {
      skipped++;
      continue;
    }
    rows.push({
      position,
      domain,
      url: rawUrl.slice(0, 2000),
      title: title ? (r[title] ?? '').trim().slice(0, 300) || null : null,
    });
  }
  return { rows, skipped, warnings: [] };
}

/** Competidores: una columna con el dominio. */
export function parseCompetitorsCsv(text: string): ParsedCsv<CompetitorCsvRow> {
  const { headers, records } = readTable(text);
  guardSize(records);
  const dom = columnFor(headers, 'domain');
  if (!dom) {
    throw new SistrixCsvError(
      'No encuentro la columna del dominio. Exporta de SISTRIX los competidores del dominio.',
    );
  }
  const seen = new Set<string>();
  const rows: CompetitorCsvRow[] = [];
  let skipped = 0;
  for (const r of records) {
    const domain = normalizeSeoDomain(r[dom] ?? '');
    if (!domain || seen.has(domain)) {
      skipped++;
      continue;
    }
    seen.add(domain);
    rows.push({ domain });
  }
  return { rows, skipped, warnings: [] };
}

export function parseSistrixCsv(kind: SeoSistrixCsvKind, text: string) {
  switch (kind) {
    case 'domain_keywords':
      return parseDomainKeywordsCsv(text);
    case 'serp':
      return parseSerpCsv(text);
    case 'competitors':
      return parseCompetitorsCsv(text);
  }
}
