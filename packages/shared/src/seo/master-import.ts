import { shiftDate } from '../web/search-console';

import { parseSeoIntent, parseSeoPriority } from './diagnostics';
import {
  parseGscDate,
  type ParsedGscExport,
  type SeoImportDimension,
  type SeoImportFilter,
  type SeoImportLanguage,
  type SeoImportSheet,
} from './gsc-import';
import {
  type SeoTaskPriority,
  type SeoTaskStatus,
  type SeoTaskType,
  SEO_TASK_TYPE_LABELS,
} from './plan';
import { normalizeSeoDomain, normalizeSeoKeyword, type SeoKeywordIntent } from './sistrix';

/**
 * SEO Avanzado, PR 7: importación de los Excel maestros (§8 y §18).
 *
 * Un maestro trae, para un dominio, el catálogo de palabras con lo que se
 * propone de cada una (grupo, intención, prioridad, URL objetivo y acción),
 * las métricas de SISTRIX y de Search Console, los rankings de una muestra de
 * la competencia, los competidores, los grupos, un plan de acción y las
 * pestañas de una exportación de Search Console. Sus reglas (hoja
 * Fuentes_importacion) se respetan aquí:
 *
 * - La clave de una palabra es `keyword_id` (`dominio|palabra`) en minúsculas,
 *   sin quitar tildes.
 * - Cada hoja va a su sitio y el histórico no se pisa: las métricas son
 *   observaciones con su fecha, fuente y país.
 * - Celda vacía = no consultado; un cero es un valor devuelto. Nunca se
 *   convierte un vacío en cero.
 * - El CTR y la posición de un día sin impresiones no significan nada.
 * - Intención, prioridad y URL objetivo son propuestas: solo rellenan lo vacío.
 *
 * Aquí solo se interpreta el contenido ya leído; el API decide qué se crea,
 * qué se rellena y qué se omite con lo que ya hay guardado.
 */

/** Error de contenido: el fichero no es un maestro que se pueda importar. */
export class SeoMasterImportError extends Error {}

export const SEO_MASTER_SHEETS = [
  'summary',
  'keywords',
  'rankings',
  'competitors',
  'clusters',
  'plan',
  'gsc',
  'rules',
] as const;
export type SeoMasterSheet = (typeof SEO_MASTER_SHEETS)[number];

/** Nombre de la hoja en el Excel. */
export const SEO_MASTER_SHEET_NAMES: Record<SeoMasterSheet, string> = {
  summary: 'Resumen',
  keywords: 'Maestro_keywords',
  rankings: 'Rankings_competencia',
  competitors: 'Competidores',
  clusters: 'Clusters',
  plan: 'Plan_accion',
  gsc: 'GSC_*',
  rules: 'Fuentes_importacion',
};

/** Adónde va cada hoja, en palabras. */
export const SEO_MASTER_SHEET_LABELS: Record<SeoMasterSheet, string> = {
  summary: 'Resumen',
  keywords: 'Palabras del catálogo',
  rankings: 'Posiciones de la competencia',
  competitors: 'Competidores',
  clusters: 'Grupos de palabras',
  plan: 'Tareas del plan',
  gsc: 'Search Console',
  rules: 'Reglas de importación',
};

/** Los avisos y filas rechazadas que se guardan con la importación. */
export const SEO_MASTER_MAX_ISSUES = 300;
/** Límite de tamaño del fichero (el mismo que la importación de Search Console). */
export const SEO_MASTER_MAX_BYTES = 20 * 1024 * 1024;

// ------------------------------------------------------------------ tipos

export interface SeoMasterSummaryRow {
  indicator: string;
  value: string;
  note: string;
}

export interface SeoMasterRule {
  field: string;
  rule: string;
  source: string;
}

export interface SeoMasterIssue {
  sheet: SeoMasterSheet;
  /** Fila del Excel (la cabecera es la 1). */
  line: number;
  value: string;
  reason: string;
  /** `rejected`: la fila no entra. `warning`: entra, con un dato de menos. */
  level: 'rejected' | 'warning';
}

export interface SeoMasterKeywordRow {
  line: number;
  /** `dominio|palabra` en minúsculas, con tildes. */
  key: string;
  keyword: string;
  group: string | null;
  intent: SeoKeywordIntent | null;
  intentLabel: string;
  priority: 1 | 2 | 3 | null;
  priorityLabel: string;
  targetUrl: string | null;
  /** Agregado del periodo de Search Console (null = no consultado). */
  gsc: {
    clicks: number | null;
    impressions: number | null;
    ctr: number | null;
    position: number | null;
  } | null;
  /** Métricas de SISTRIX (null = no consultadas). Un 0 es un valor. */
  sistrix: {
    traffic: number | null;
    competition: number | null;
    cpc: number | null;
    clicks: number | null;
  } | null;
  ownPosition: number | null;
  status: string;
  /** Marcada para descartar: entra en el catálogo, pero sin seguir. */
  discard: boolean;
  action: string;
  /** Peso de relevancia (0–4). */
  relevance: number | null;
  consultedAt: string | null;
  country: string | null;
  gscFrom: string | null;
  gscTo: string | null;
  source: string;
}

export interface SeoMasterRankingRow {
  line: number;
  domain: string;
  keyword: string;
  position: number;
  url: string;
  country: string;
  date: string;
}

export interface SeoMasterCompetitorRow {
  line: number;
  domain: string;
  status: string;
  sampleRows: number | null;
  uniqueKeywords: number | null;
  top10: number | null;
  strategy: string;
}

export interface SeoMasterClusterRow {
  line: number;
  name: string;
  keywords: number | null;
  impressions: number | null;
  clicks: number | null;
  priority: 1 | 2 | 3 | null;
  priorityLabel: string;
  targetUrl: string | null;
  note: string;
}

export interface SeoMasterDeadline {
  label: string;
  days: number | null;
  months: number | null;
}

export interface SeoMasterPlanRow {
  line: number;
  ref: string;
  deadline: SeoMasterDeadline | null;
  deadlineLabel: string;
  cluster: string;
  path: string;
  action: string;
  title: string;
  detail: string;
  kpi: string;
  status: SeoTaskStatus;
  statusLabel: string;
  type: SeoTaskType;
}

export interface ParsedSeoMaster {
  domain: string;
  extractedAt: string | null;
  gscFrom: string | null;
  gscTo: string | null;
  summary: SeoMasterSummaryRow[];
  rules: SeoMasterRule[];
  keywords: SeoMasterKeywordRow[];
  rankings: SeoMasterRankingRow[];
  competitors: SeoMasterCompetitorRow[];
  clusters: SeoMasterClusterRow[];
  plan: SeoMasterPlanRow[];
  /** Las pestañas GSC_* con los nombres de una exportación de Search Console. */
  gscSheets: SeoImportSheet[];
  /** Filas de datos de cada hoja (sin la cabecera). */
  sheetRows: Partial<Record<SeoMasterSheet, number>>;
  issues: SeoMasterIssue[];
}

// --------------------------------------------------------------- mapeos

/** Sin tildes, en minúsculas y con los guiones bajos como espacios. */
const label = (v: string | undefined) =>
  (v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();

/**
 * Intención propuesta del maestro → la nuestra. «Mixta» y «Excluir /
 * observar» no se adivinan: se quedan sin intención (la deducen SISTRIX o las
 * reglas). `invalid` si no se entiende.
 */
export function parseMasterIntent(value: string | undefined): SeoKeywordIntent | null | 'invalid' {
  const v = label(value);
  if (!v) return null;
  if (v === 'mixta' || v === 'mixed' || v.startsWith('excluir')) return null;
  return parseSeoIntent(value);
}

/** Prioridad del maestro: «Muy alta» y «Alta» → 1, «Media» → 2, «Baja» → 3. */
export function parseMasterPriority(value: string | undefined): 1 | 2 | 3 | null | 'invalid' {
  const v = label(value);
  if (!v) return null;
  if (v === 'muy alta' || v === 'maxima' || v === 'alta') return 1;
  if (v === 'muy baja') return 3;
  return parseSeoPriority(value);
}

/** Prioridad de una tarea según la de su grupo. */
export function masterTaskPriority(groupPriority: 1 | 2 | 3 | null | undefined): SeoTaskPriority {
  if (groupPriority === 1) return 'high';
  if (groupPriority === 3) return 'low';
  return 'medium';
}

/**
 * Número de una celda: vacía → null (no consultado), un número → el número
 * (un 0 es un valor devuelto), cualquier otra cosa → `invalid`.
 */
export function parseMasterNumber(value: string | undefined): number | null | 'invalid' {
  let v = (value ?? '').replace(/[\s\u00a0]/g, '');
  if (!v) return null;
  if (v.includes(',') && !v.includes('.')) v = v.replace(',', '.');
  if (!/^-?\d+(\.\d+)?([eE]-?\d+)?$/.test(v)) return 'invalid';
  const n = Number(v);
  return Number.isFinite(n) ? n : 'invalid';
}

/** Plazo del plan: «Semana 2» → 14 días; «Mes 2» → 2 meses. */
export function parseMasterDeadline(value: string | undefined): SeoMasterDeadline | null {
  const v = label(value);
  const week = /^semana\s*(\d{1,2})$/.exec(v) ?? /^week\s*(\d{1,2})$/.exec(v);
  if (week) return { label: (value ?? '').trim(), days: 7 * Number(week[1]), months: null };
  const month = /^mes\s*(\d{1,2})$/.exec(v) ?? /^month\s*(\d{1,2})$/.exec(v);
  if (month) return { label: (value ?? '').trim(), days: null, months: Number(month[1]) };
  return null;
}

/** Suma meses a una fecha (si el día no existe, el último del mes). */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Fecha límite de una tarea: el día de la importación más el plazo. */
export function masterDueDate(
  deadline: SeoMasterDeadline | null,
  importDate: string,
): string | null {
  if (!deadline) return null;
  if (deadline.days !== null) return shiftDate(importDate, deadline.days);
  if (deadline.months !== null) return addMonths(importDate, deadline.months);
  return null;
}

/** Estado del plan → el de la tarea (lo que no se entiende, por hacer). */
export function masterTaskStatus(value: string | undefined): SeoTaskStatus {
  const v = label(value);
  if (['en curso', 'en progreso', 'haciendo', 'iniciada', 'in progress'].includes(v)) {
    return 'in_progress';
  }
  if (['en revision', 'revision', 'review'].includes(v)) return 'review';
  if (
    ['hecha', 'hecho', 'completada', 'completado', 'terminada', 'terminado', 'done'].includes(v)
  ) {
    return 'done';
  }
  if (['cancelada', 'cancelado', 'descartada', 'descartado', 'cancelled'].includes(v)) {
    return 'cancelled';
  }
  return 'todo';
}

/** Tipo de tarea según la acción (y el grupo) del plan. */
export function masterTaskType(action: string | undefined, group?: string): SeoTaskType {
  const a = label(action);
  const g = label(group);
  if (a.includes('local') || g.includes('proximidad') || g.includes('seo local')) return 'local';
  if (a.includes('enlace') || a.includes('link')) return 'links';
  if (a.startsWith('auditar') || a.includes('tecnic') || g.includes('tecnic')) return 'technical';
  if (/(optimizar|crear|validar|revisar|reescribir|ampliar|redactar|contenido)/.test(a)) {
    return 'content';
  }
  return 'other';
}

/** URL de una ruta del plan en el dominio del maestro. */
export function masterTaskUrl(domain: string, path: string): string | null {
  const p = path.trim();
  if (/^https?:\/\//i.test(p)) return p.slice(0, 2000);
  if (p.startsWith('/')) return `https://${domain}${p}`.slice(0, 2000);
  return null;
}

const NO_VALUE = new Set(['', '-', '—', '–', 'n/a', 'na']);

/** Título de la tarea: el propuesto o, si no hay, la acción y la ruta. */
export function masterTaskTitle(row: Pick<SeoMasterPlanRow, 'title' | 'action' | 'path' | 'ref'>) {
  const title = NO_VALUE.has(row.title.trim().toLowerCase()) ? '' : row.title.trim();
  const base = title || [row.action.trim(), row.path.trim()].filter(Boolean).join(': ') || row.ref;
  return base.slice(0, 200);
}

/** Descripción de la tarea: el detalle, el título propuesto, el KPI y de dónde sale. */
export function masterTaskDescription(row: SeoMasterPlanRow): string {
  const title = NO_VALUE.has(row.title.trim().toLowerCase()) ? '' : row.title.trim();
  const lines = [
    row.detail.trim(),
    '',
    title ? `Título propuesto: ${title}` : '',
    row.kpi.trim() ? `KPI: ${row.kpi.trim()}` : '',
    row.cluster.trim() ? `Grupo: ${row.cluster.trim()}` : '',
    `Del plan del maestro: ${row.ref}${row.deadlineLabel ? ` · ${row.deadlineLabel}` : ''}`,
  ];
  return lines
    .filter((l, i) => l !== '' || i === 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

/** Notas de una palabra nueva: la acción, el estado y el peso del maestro. */
export function masterKeywordNotes(
  row: Pick<SeoMasterKeywordRow, 'action' | 'status' | 'relevance'>,
): string | null {
  const parts = [
    row.action.trim(),
    row.status.trim(),
    row.relevance === null ? '' : `relevancia ${row.relevance}/4`,
  ].filter(Boolean);
  return parts.length ? `Del maestro: ${parts.join(' · ')}`.slice(0, 1000) : null;
}

/** «Importado del maestro, 25/11/2026» (la fecha, en hora de España). */
export function seoMasterOriginLabel(importedAt: string): string {
  const date = new Date(importedAt);
  const text = Number.isNaN(date.getTime())
    ? importedAt
    : date.toLocaleDateString('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
  return `Importado del maestro, ${text}`;
}

/** Hoja de los rankings: país en minúsculas, como lo guarda SISTRIX. */
const country = (v: string | undefined) => (v ?? '').trim().toLowerCase().slice(0, 8);

// -------------------------------------------------------------- lectura

const SHEET_ALIASES: Record<string, Exclude<SeoMasterSheet, 'gsc'>> = {
  resumen: 'summary',
  summary: 'summary',
  'maestro keywords': 'keywords',
  'maestro palabras': 'keywords',
  'rankings competencia': 'rankings',
  competidores: 'competitors',
  clusters: 'clusters',
  grupos: 'clusters',
  'plan accion': 'plan',
  'fuentes importacion': 'rules',
};

/** Pestañas GSC_* → los nombres de una exportación de Search Console. */
const GSC_SHEETS: Record<string, string> = {
  'gsc consultas': 'Consultas',
  'gsc paginas': 'Páginas',
  'gsc diario': 'Fechas',
  'gsc fechas': 'Fechas',
  'gsc paises': 'Países',
  'gsc dispositivos': 'Dispositivos',
  'gsc aparicion': 'Aspecto en las búsquedas',
  'gsc aspecto': 'Aspecto en las búsquedas',
  'gsc filtros': 'Filtros',
};

const nonEmpty = (rows: string[][]) => rows.filter((r) => r.some((c) => (c ?? '').trim() !== ''));

/** Columnas por su nombre (sin tildes, mayúsculas ni guiones bajos). */
function headerIndex(header: readonly string[]) {
  const map = new Map<string, number>();
  header.forEach((h, i) => {
    const key = label(h);
    if (key && !map.has(key)) map.set(key, i);
  });
  return (row: readonly string[], ...names: string[]) => {
    for (const name of names) {
      const i = map.get(label(name));
      if (i !== undefined) return (row[i] ?? '').trim();
    }
    return '';
  };
}

const hasColumn = (header: readonly string[], name: string) =>
  header.some((h) => label(h) === label(name));

/**
 * Interpreta un maestro ya leído (una lista de hojas con sus filas de texto).
 * Lanza `SeoMasterImportError` si no es un maestro; las filas que no entran
 * van en `issues` con el motivo.
 */
export function parseSeoMaster(sheets: readonly SeoImportSheet[]): ParsedSeoMaster {
  const bySheet = new Map<Exclude<SeoMasterSheet, 'gsc'>, string[][]>();
  const gscSheets: SeoImportSheet[] = [];
  for (const s of sheets) {
    const key = label(s.name);
    const gscName = GSC_SHEETS[key];
    if (gscName) {
      gscSheets.push({ name: gscName, rows: s.rows });
      continue;
    }
    const kind = SHEET_ALIASES[key];
    if (kind && !bySheet.has(kind)) bySheet.set(kind, nonEmpty(s.rows));
  }
  const issues: SeoMasterIssue[] = [];
  const sheetRows: Partial<Record<SeoMasterSheet, number>> = {};
  const issue = (
    sheet: SeoMasterSheet,
    line: number,
    value: string,
    reason: string,
    level: SeoMasterIssue['level'] = 'rejected',
  ) => issues.push({ sheet, line, value: value.slice(0, 200), reason, level });

  // ----------------------------------------------------------- Resumen
  const summaryRows = bySheet.get('summary');
  if (!summaryRows || summaryRows.length === 0) {
    throw new SeoMasterImportError(
      'No parece un maestro de SEO: falta la hoja Resumen (con el dominio y las fechas).',
    );
  }
  const summaryBody =
    label(summaryRows[0]![0]) === 'indicador' ? summaryRows.slice(1) : summaryRows;
  const summary: SeoMasterSummaryRow[] = summaryBody
    .map((r) => ({
      indicator: (r[0] ?? '').trim(),
      value: (r[1] ?? '').trim(),
      note: (r[2] ?? '').trim(),
    }))
    .filter((r) => r.indicator)
    .slice(0, 100);
  sheetRows.summary = summary.length;
  const summaryValue = (...names: string[]) =>
    summary.find((r) => names.includes(label(r.indicator)))?.value ?? '';
  const domain = normalizeSeoDomain(summaryValue('dominio', 'domain'));
  if (!domain) {
    throw new SeoMasterImportError(
      'La hoja Resumen no dice de qué dominio es el maestro (la fila «Dominio»).',
    );
  }
  const extractedAt = parseGscDate(summaryValue('fecha extraccion', 'fecha de extraccion'));
  const gscFrom = parseGscDate(summaryValue('inicio gsc'));
  const gscTo = parseGscDate(summaryValue('fin gsc'));

  // ---------------------------------------------------- Fuentes_importacion
  const ruleRows = bySheet.get('rules') ?? [];
  const rules: SeoMasterRule[] = (
    ruleRows.length && label(ruleRows[0]![0]).startsWith('campo') ? ruleRows.slice(1) : ruleRows
  )
    .map((r) => ({
      field: (r[0] ?? '').trim(),
      rule: (r[1] ?? '').trim(),
      source: (r[2] ?? '').trim(),
    }))
    .filter((r) => r.field || r.rule)
    .slice(0, 100);
  sheetRows.rules = rules.length;

  // ------------------------------------------------------ Maestro_keywords
  const kwRows = bySheet.get('keywords');
  if (!kwRows || kwRows.length === 0) {
    throw new SeoMasterImportError('No parece un maestro de SEO: falta la hoja Maestro_keywords.');
  }
  const kwHeader = kwRows[0]!;
  if (!hasColumn(kwHeader, 'keyword_id') && !hasColumn(kwHeader, 'keyword')) {
    throw new SeoMasterImportError(
      'La hoja Maestro_keywords no tiene las columnas keyword_id ni keyword.',
    );
  }
  const kw = headerIndex(kwHeader);
  const keywords: SeoMasterKeywordRow[] = [];
  const seenKeys = new Set<string>();
  sheetRows.keywords = kwRows.length - 1;
  kwRows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const rawWord = kw(r, 'keyword');
    const rawKey = kw(r, 'keyword_id');
    const key = (rawKey || (rawWord ? `${domain}|${rawWord}` : ''))
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const [keyDomain, ...rest] = key.split('|');
    const keyWord = rest.join('|');
    const keyword = normalizeSeoKeyword(rawWord || keyWord);
    if (!key || keyword.length < 2) {
      issue('keywords', line, key, 'Falta la palabra (o tiene menos de 2 letras).');
      return;
    }
    if (keyword.length > 120) {
      issue('keywords', line, keyword, 'La palabra pasa de 120 caracteres.');
      return;
    }
    if (rest.length === 0 || normalizeSeoDomain(keyDomain ?? '') !== domain) {
      issue(
        'keywords',
        line,
        key,
        `El keyword_id no es de ${domain} (tiene que ser «${domain}|palabra»).`,
      );
      return;
    }
    if (seenKeys.has(key)) {
      issue('keywords', line, key, 'El keyword_id está repetido en el maestro (vale la primera).');
      return;
    }
    seenKeys.add(key);
    const num = (col: string) => {
      const n = parseMasterNumber(kw(r, col));
      if (n === 'invalid') {
        issue(
          'keywords',
          line,
          `${col}: ${kw(r, col)}`,
          `«${kw(r, col)}» en ${col} no es un número: se queda sin dato.`,
          'warning',
        );
        return null;
      }
      return n;
    };
    const intentLabel = kw(r, 'intencion_propuesta', 'intencion');
    let intent = parseMasterIntent(intentLabel);
    if (intent === 'invalid') {
      issue(
        'keywords',
        line,
        intentLabel,
        `No se entiende la intención «${intentLabel}»: se queda sin intención.`,
        'warning',
      );
      intent = null;
    }
    const priorityLabel = kw(r, 'prioridad');
    let priority = parseMasterPriority(priorityLabel);
    if (priority === 'invalid') {
      issue(
        'keywords',
        line,
        priorityLabel,
        `No se entiende la prioridad «${priorityLabel}»: se queda en media.`,
        'warning',
      );
      priority = null;
    }
    const rawUrl = kw(r, 'url_objetivo_propuesta', 'url_objetivo');
    let targetUrl: string | null = null;
    if (rawUrl) {
      if (/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(rawUrl) && rawUrl.length <= 500) targetUrl = rawUrl;
      else {
        issue(
          'keywords',
          line,
          rawUrl,
          'La URL objetivo no empieza por https://: se queda sin URL.',
          'warning',
        );
      }
    }
    const clicks = num('gsc_clics');
    const impressions = num('gsc_impresiones');
    // El CTR va en fracción (0,125); si el maestro lo trae en porcentaje (12,5)
    // se pasa a fracción, y lo imposible se descarta (la columna es DECIMAL(7,6)).
    const rawCtr = num('gsc_ctr');
    const ctr =
      rawCtr === null || rawCtr < 0
        ? null
        : rawCtr <= 1
          ? rawCtr
          : rawCtr <= 100
            ? Math.round(rawCtr * 1e4) / 1e6
            : null;
    const gscPosition = num('gsc_posicion_media');
    const shown = impressions !== null && impressions > 0;
    const gsc =
      clicks === null && impressions === null && ctr === null && gscPosition === null
        ? null
        : {
            clicks,
            impressions,
            // Sin impresiones, el CTR y la posición no significan nada.
            ctr: shown ? ctr : null,
            position: shown ? gscPosition : null,
          };
    const traffic = num('sistrix_volumen_mes');
    const competition = num('sistrix_competencia');
    const cpc = num('sistrix_cpc_eur');
    const sistrixClicks = num('sistrix_clics_mes');
    const sistrix =
      traffic === null && competition === null && cpc === null && sistrixClicks === null
        ? null
        : { traffic, competition, cpc, clicks: sistrixClicks };
    const own = num('sistrix_posicion_propia');
    const relevance = num('peso_relevancia');
    const status = kw(r, 'estado');
    keywords.push({
      line,
      key,
      keyword,
      group: kw(r, 'cluster', 'grupo').slice(0, 80) || null,
      intent,
      intentLabel,
      priority,
      priorityLabel,
      targetUrl,
      gsc,
      sistrix,
      ownPosition: own !== null && own >= 1 ? Math.round(own) : null,
      status,
      discard: label(status) === 'descartar' || label(intentLabel).startsWith('excluir'),
      action: kw(r, 'accion_propuesta'),
      relevance: relevance === null ? null : Math.max(0, Math.min(4, Math.round(relevance))),
      consultedAt: parseGscDate(kw(r, 'fecha_consulta')),
      country: country(kw(r, 'sistrix_pais')) || null,
      gscFrom: parseGscDate(kw(r, 'gsc_inicio')),
      gscTo: parseGscDate(kw(r, 'gsc_fin')),
      source: kw(r, 'fuente'),
    });
  });

  // -------------------------------------------------- Rankings_competencia
  const rankRows = bySheet.get('rankings') ?? [];
  const rankings: SeoMasterRankingRow[] = [];
  if (rankRows.length > 0) {
    const rk = headerIndex(rankRows[0]!);
    sheetRows.rankings = rankRows.length - 1;
    const best = new Map<string, SeoMasterRankingRow>();
    rankRows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const d = normalizeSeoDomain(rk(r, 'dominio', 'domain'));
      const keyword = normalizeSeoKeyword(rk(r, 'keyword', 'palabra'));
      const pos = parseMasterNumber(rk(r, 'posicion', 'position'));
      if (!d) {
        issue('rankings', line, rk(r, 'dominio'), 'El dominio no es válido.');
        return;
      }
      if (keyword.length < 2) {
        issue('rankings', line, d, 'Falta la palabra.');
        return;
      }
      if (pos === null || pos === 'invalid' || pos < 1 || !Number.isInteger(pos)) {
        issue(
          'rankings',
          line,
          `${d} · ${keyword}`,
          'La posición no es un número entero mayor que 0.',
        );
        return;
      }
      const row: SeoMasterRankingRow = {
        line,
        domain: d,
        keyword,
        position: pos,
        url: rk(r, 'url').slice(0, 2000),
        country: country(rk(r, 'pais', 'country')) || 'es',
        date: parseGscDate(rk(r, 'fecha_consulta', 'fecha')) ?? extractedAt ?? '',
      };
      if (!row.date) {
        issue(
          'rankings',
          line,
          `${d} · ${keyword}`,
          'Sin fecha de consulta (ni en la fila ni en el Resumen).',
        );
        return;
      }
      const dedupe = `${row.domain}|${row.country}|${row.date}|${row.keyword}`;
      const prev = best.get(dedupe);
      if (prev) {
        const [keep, drop] = row.position < prev.position ? [row, prev] : [prev, row];
        best.set(dedupe, keep);
        issue(
          'rankings',
          drop.line,
          `${d} · ${keyword} · ${drop.position} (se guarda la ${keep.position})`,
          'La misma palabra y dominio aparece más de una vez con la misma fecha: se guarda la mejor posición.',
        );
        return;
      }
      best.set(dedupe, row);
    });
    rankings.push(...[...best.values()].sort((a, b) => a.line - b.line));
  }

  // ---------------------------------------------------------- Competidores
  const compRows = bySheet.get('competitors') ?? [];
  const competitors: SeoMasterCompetitorRow[] = [];
  if (compRows.length > 0) {
    const cp = headerIndex(compRows[0]!);
    sheetRows.competitors = compRows.length - 1;
    const seen = new Set<string>();
    compRows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const d = normalizeSeoDomain(cp(r, 'dominio', 'domain'));
      if (!d) {
        issue('competitors', line, cp(r, 'dominio'), 'El dominio no es válido.');
        return;
      }
      if (seen.has(d)) {
        issue('competitors', line, d, 'Está repetido (vale el primero).');
        return;
      }
      seen.add(d);
      const n = (col: string) => {
        const v = parseMasterNumber(cp(r, col));
        return v === 'invalid' ? null : v;
      };
      competitors.push({
        line,
        domain: d,
        status: cp(r, 'estado_consulta', 'estado'),
        sampleRows: n('filas_muestra'),
        uniqueKeywords: n('keywords_unicas'),
        top10: n('keywords_top10'),
        strategy: cp(r, 'estrategia_observada', 'estrategia'),
      });
    });
  }

  // -------------------------------------------------------------- Clusters
  const clRows = bySheet.get('clusters') ?? [];
  const clusters: SeoMasterClusterRow[] = [];
  if (clRows.length > 0) {
    const cl = headerIndex(clRows[0]!);
    sheetRows.clusters = clRows.length - 1;
    const seen = new Set<string>();
    clRows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const name = cl(r, 'cluster', 'grupo').slice(0, 80);
      if (!name) {
        issue('clusters', line, '', 'Falta el nombre del grupo.');
        return;
      }
      if (seen.has(name.toLowerCase())) {
        issue('clusters', line, name, 'Está repetido (vale el primero).');
        return;
      }
      seen.add(name.toLowerCase());
      const priorityLabel = cl(r, 'prioridad_propuesta', 'prioridad');
      const priority = parseMasterPriority(priorityLabel);
      if (priority === 'invalid') {
        issue(
          'clusters',
          line,
          priorityLabel,
          `No se entiende la prioridad «${priorityLabel}».`,
          'warning',
        );
      }
      const url = cl(r, 'url_objetivo_principal', 'url_objetivo');
      const targetUrl = /^https?:\/\/\S+$/i.test(url) && url.length <= 500 ? url : null;
      if (url && !targetUrl) {
        issue(
          'clusters',
          line,
          url,
          'La URL objetivo no empieza por https://: se queda sin URL.',
          'warning',
        );
      }
      const n = (col: string) => {
        const v = parseMasterNumber(cl(r, col));
        return v === 'invalid' ? null : v;
      };
      clusters.push({
        line,
        name,
        keywords: n('keywords'),
        impressions: n('impresiones_gsc_exportadas'),
        clicks: n('clics_gsc_exportados'),
        priority: priority === 'invalid' ? null : priority,
        priorityLabel,
        targetUrl,
        note: cl(r, 'nota', 'notas').slice(0, 1000),
      });
    });
  }

  // ----------------------------------------------------------- Plan_accion
  const plRows = bySheet.get('plan') ?? [];
  const plan: SeoMasterPlanRow[] = [];
  if (plRows.length > 0) {
    const pl = headerIndex(plRows[0]!);
    sheetRows.plan = plRows.length - 1;
    const seen = new Set<string>();
    plRows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const ref = pl(r, 'id').toUpperCase().slice(0, 40);
      if (!ref) {
        issue('plan', line, pl(r, 'accion'), 'Falta el id de la tarea (P01…).');
        return;
      }
      if (seen.has(ref)) {
        issue('plan', line, ref, 'El id está repetido (vale el primero).');
        return;
      }
      seen.add(ref);
      const deadlineLabel = pl(r, 'plazo');
      const deadline = parseMasterDeadline(deadlineLabel);
      if (deadlineLabel && !deadline) {
        issue(
          'plan',
          line,
          deadlineLabel,
          `No se entiende el plazo «${deadlineLabel}»: queda sin fecha límite.`,
          'warning',
        );
      }
      const action = pl(r, 'accion');
      const cluster = pl(r, 'cluster', 'grupo');
      const statusLabel = pl(r, 'estado');
      plan.push({
        line,
        ref,
        deadline,
        deadlineLabel,
        cluster,
        path: pl(r, 'ruta_propuesta', 'ruta', 'url'),
        action,
        title: pl(r, 'title_propuesto', 'titulo_propuesto'),
        detail: pl(r, 'detalle'),
        kpi: pl(r, 'kpi'),
        status: masterTaskStatus(statusLabel),
        statusLabel,
        type: masterTaskType(action, cluster),
      });
    });
  }

  sheetRows.gsc = gscSheets.reduce((n, s) => n + Math.max(0, nonEmpty(s.rows).length - 1), 0);

  return {
    domain,
    extractedAt,
    gscFrom,
    gscTo,
    summary,
    rules,
    keywords,
    rankings,
    competitors,
    clusters,
    plan,
    gscSheets,
    sheetRows,
    issues,
  };
}

/**
 * Las palabras con datos de Search Console que no salen en la pestaña de
 * consultas (si son del mismo periodo) se añaden a ella: son el mismo agregado
 * del periodo, nunca repartido por días. Devuelve cuántas se han añadido.
 */
export function mergeMasterGscQueries(
  gsc: ParsedGscExport,
  keywords: readonly SeoMasterKeywordRow[],
): number {
  let tab = gsc.tabs.find((t) => t.dimension === 'query');
  if (!tab) {
    tab = { dimension: 'query', rows: [] };
    gsc.tabs.unshift(tab);
  }
  const have = new Set(tab.rows.map((r) => normalizeSeoKeyword(r.value)));
  let added = 0;
  for (const k of keywords) {
    if (!k.gsc || k.gsc.impressions === null || k.gsc.clicks === null) continue;
    if (k.gscFrom && k.gscFrom !== gsc.periodFrom) continue;
    if (k.gscTo && k.gscTo !== gsc.periodTo) continue;
    if (have.has(k.keyword)) continue;
    have.add(k.keyword);
    tab.rows.push({
      value: k.keyword,
      clicks: Math.round(k.gsc.clicks),
      impressions: Math.round(k.gsc.impressions),
      ctr: k.gsc.ctr,
      position: k.gsc.position,
    });
    added++;
  }
  return added;
}

/** Etiqueta del tipo de tarea (para la vista previa). */
export const seoMasterTaskTypeLabel = (t: SeoTaskType) => SEO_TASK_TYPE_LABELS[t];

// ------------------------------------------------------------------- DTO

export interface SeoMasterSheetResultDto {
  sheet: SeoMasterSheet;
  /** Filas de datos de la hoja. */
  rows: number;
  created: number;
  /** Rellenadas (lo vacío) o actualizadas. */
  updated: number;
  /** Ya estaban y no había nada que rellenar. */
  unchanged: number;
  skipped: number;
  /** Por qué se omitieron (y otros avisos), con cuántas filas. */
  reasons: { reason: string; count: number }[];
  /** Lo que se hace además (observaciones guardadas, sugerencias…). */
  notes: string[];
}

export interface SeoMasterGscDto {
  periodFrom: string;
  periodTo: string;
  language: SeoImportLanguage;
  tabRows: Partial<Record<SeoImportDimension, number>>;
  filters: SeoImportFilter[];
  filtered: boolean;
  filterReasons: string[];
  warnings: string[];
  /** Días de GSC_diario que entran en los totales del sitio. */
  siteDaysToAdd: number;
  /** Días que ya tiene la API (mandan los suyos). */
  siteDaysApi: number;
  /** Días que ya vienen de otra importación. */
  siteDaysImported: number;
  /** Palabras de Maestro_keywords que no estaban en GSC_consultas. */
  addedQueries: number;
}

export type SeoMasterIssueDto = SeoMasterIssue;

export interface SeoMasterPreviewDto {
  fileName: string;
  fileHash: string;
  domainId: string;
  domain: string;
  extractedAt: string | null;
  gscFrom: string | null;
  gscTo: string | null;
  /** Día de la importación (las fechas límite de las tareas cuentan desde aquí). */
  importDate: string;
  summary: SeoMasterSummaryRow[];
  rules: SeoMasterRule[];
  sheets: SeoMasterSheetResultDto[];
  gsc: SeoMasterGscDto | null;
  issues: SeoMasterIssueDto[];
  issuesTotal: number;
}

export interface SeoMasterImportDto {
  id: string;
  domainId: string;
  domain: string;
  fileName: string;
  extractedAt: string | null;
  gscFrom: string | null;
  gscTo: string | null;
  sheets: SeoMasterSheetResultDto[];
  issuesTotal: number;
  /** La importación de Search Console que hizo con las pestañas GSC_*. */
  gscImportId: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface SeoKeywordGroupDto {
  id: string;
  name: string;
  priority: number | null;
  targetUrl: string | null;
  notes: string | null;
  source: 'manual' | 'master';
  /** Si lo creó un maestro: cuándo. */
  masterImportedAt: string | null;
  /** Palabras del catálogo con ese grupo. */
  keywords: number;
}

export interface SeoMasterImportDetailDto extends SeoMasterImportDto {
  summary: SeoMasterSummaryRow[];
  rules: SeoMasterRule[];
  issues: SeoMasterIssueDto[];
  groups: SeoKeywordGroupDto[];
}

export interface SeoMasterRemoveResultDto {
  /** Lo que se ha quitado (creado por la importación y sin tocar después). */
  removed: number;
  /** Lo que se queda porque se cambió a mano después. */
  kept: number;
  /** Campos que rellenó y se han vaciado otra vez. */
  reverted: number;
}
