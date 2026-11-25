import { z } from 'zod';

import { shiftDate, type SeoTotalsDto } from '../web/search-console';

import { normalizeSeoUrl } from './diagnostics';
import { seoChange, type SeoChangeDto } from './metrics';
import { seoFmtInt } from './opportunities';
import { seoPeriodCovered, type SeoDashboardDayDto } from './panel';
import { normalizeSeoKeyword } from './sistrix';

/**
 * SEO Avanzado, PR 6 (fase 3): el plan. Actuaciones (cambios hechos en la web)
 * con su antes y después a 7, 28 y 90 días (§18.8 y §19.6) y tareas SEO con
 * tablero y calendario (§8; el calendario de contenidos es una vista de las
 * tareas, §15.2). Todo lo de este fichero es puro: el API suma con SQL y aquí
 * se decide si una ventana se puede comparar y qué se dice de ella.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, 'Fecha no válida');
const timeField = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora no válida');
const idField = z.string().uuid();

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// --------------------------------------------------------------- actuaciones

export const SEO_SITE_CHANGE_TYPES = [
  'title_meta',
  'content',
  'new_page',
  'internal_links',
  'redirect',
  'technical',
  'noindex',
  'target_url',
  'other',
] as const;
export type SeoSiteChangeType = (typeof SEO_SITE_CHANGE_TYPES)[number];
export const SeoSiteChangeTypeEnum = z.enum(SEO_SITE_CHANGE_TYPES);
export const SEO_SITE_CHANGE_TYPE_LABELS: Record<SeoSiteChangeType, string> = {
  title_meta: 'Título o descripción',
  content: 'Contenido',
  new_page: 'Página nueva',
  internal_links: 'Enlazado interno',
  redirect: 'Redirección',
  technical: 'Técnica',
  noindex: 'noindex o robots',
  target_url: 'URL objetivo',
  other: 'Otra',
};

/** Ventanas de la comparación antes/después (días a cada lado). */
export const SEO_SITE_CHANGE_WINDOWS = [7, 28, 90] as const;
export type SeoSiteChangeWindow = (typeof SEO_SITE_CHANGE_WINDOWS)[number];

/**
 * Días que se dejan a Google para dar por definitivos los datos de un día
 * (suele tardar 2 o 3). Una ventana no se compara hasta pasado este margen.
 */
export const SEO_GSC_FINAL_DELAY_DAYS = 3;

/**
 * Impresiones mínimas en cada lado para sacar una conclusión (con menos, «pocos
 * datos»). Con 20 impresiones, que salgan 30 es ruido, no una mejora.
 */
export const SEO_SITE_CHANGE_MIN_IMPRESSIONS = 50;

export const SEO_SITE_CHANGE_LIMITS = { urls: 50, keywords: 100 } as const;
export const SEO_SITE_CHANGE_PAGE_SIZE = 50;
export const SEO_SITE_CHANGE_CSV_MAX = 5_000;

const changeFields = {
  /** Dominio del proyecto (vacío = el principal). */
  domainId: idField.nullable(),
  /** Día del cambio en hora de España. */
  date: dateField,
  /** Hora (HH:MM, hora de España), opcional. */
  time: timeField.nullable(),
  type: SeoSiteChangeTypeEnum,
  title: z.string().trim().min(2, 'Ponle un título').max(200),
  description: z.string().trim().max(4000).nullable(),
  /** URLs afectadas (se comparan normalizadas). */
  urls: z.array(z.string().trim().min(1).max(2000)).max(SEO_SITE_CHANGE_LIMITS.urls),
  /** Palabras afectadas (del catálogo o escritas a mano). */
  keywords: z.array(z.string().trim().min(1).max(200)).max(SEO_SITE_CHANGE_LIMITS.keywords),
  notes: z.string().trim().max(2000).nullable(),
  /** Lo que la motivó (opcional) y la tarea de la que sale. */
  opportunityId: idField.nullable(),
  cannibalizationId: idField.nullable(),
  indexFindingId: idField.nullable(),
  taskId: idField.nullable(),
};

export const CreateSeoSiteChangeSchema = z
  .object(changeFields)
  .partial()
  .required({ date: true, type: true, title: true });
export type CreateSeoSiteChangeInput = z.infer<typeof CreateSeoSiteChangeSchema>;

export const UpdateSeoSiteChangeSchema = z
  .object(changeFields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'No hay nada que cambiar.',
  });
export type UpdateSeoSiteChangeInput = z.infer<typeof UpdateSeoSiteChangeSchema>;

/** Alcance de una actuación, ya normalizado para compararlo con otras y con Google. */
export interface SeoSiteChangeScope {
  urlKeys: string[];
  keywords: string[];
}

/**
 * Clave de una URL apuntada a mano: «ejemplo.es/precios» se toma como
 * `https://ejemplo.es/precios`; «/precios», como la ruta en cualquier dominio.
 */
export function seoUrlKey(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const withScheme = s.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  return normalizeSeoUrl(withScheme);
}

export function seoSiteChangeScope(input: {
  urls?: readonly string[] | null;
  keywords?: readonly string[] | null;
}): SeoSiteChangeScope {
  const urlKeys = [
    ...new Set((input.urls ?? []).map((u) => seoUrlKey(u)).filter((u) => u.length > 0)),
  ];
  const keywords = [
    ...new Set((input.keywords ?? []).map((k) => normalizeSeoKeyword(k)).filter(Boolean)),
  ];
  return { urlKeys, keywords };
}

/**
 * Si una página de Search Console es la de una URL del alcance (ya
 * normalizada). Una URL apuntada sin dominio («/precios») vale en cualquier
 * dominio del proyecto.
 */
export function seoPageMatchesKey(page: string, key: string): boolean {
  const norm = normalizeSeoUrl(page);
  if (key.startsWith('/')) {
    const slash = norm.indexOf('/');
    return (slash >= 0 ? norm.slice(slash) : norm) === key;
  }
  return norm === key;
}

/** Las dos ventanas de una comparación: N días antes y N días después (el día del cambio no cuenta). */
export interface SeoSiteChangeRange {
  beforeFrom: string;
  beforeTo: string;
  afterFrom: string;
  afterTo: string;
}

export function seoSiteChangeRange(changeDate: string, days: number): SeoSiteChangeRange {
  return {
    beforeFrom: shiftDate(changeDate, -days),
    beforeTo: shiftDate(changeDate, -1),
    afterFrom: shiftDate(changeDate, 1),
    afterTo: shiftDate(changeDate, days),
  };
}

export const SEO_SITE_CHANGE_WINDOW_STATUSES = [
  'ready',
  'waiting',
  'no_history',
  'incomplete',
] as const;
export type SeoSiteChangeWindowStatus = (typeof SEO_SITE_CHANGE_WINDOW_STATUSES)[number];

export interface SeoSiteChangeWindowState {
  status: SeoSiteChangeWindowStatus;
  /** Día en que la ventana se puede comparar (fin + margen de Google). */
  availableOn: string;
  /** Días que faltan para ese día (null si ya pasó y es Google quien no da los datos). */
  daysLeft: number | null;
}

/**
 * Si una ventana se puede comparar ya. Se espera a que pasen todos sus días y
 * el margen de Google («faltan N días»); después, a que Google dé datos hasta
 * el último día. Con todo, si no hay datos de casi todos los días de los dos
 * lados (`seoPeriodCovered`, sobre el cruce `site` del dominio), «periodo
 * incompleto»; si el histórico empieza después, «sin histórico».
 */
export function seoSiteChangeWindowState(input: {
  changeDate: string;
  days: number;
  /** Hoy (fecha de España). */
  today: string;
  /** Primer y último día con datos de Google del dominio. */
  firstDataDate: string | null;
  lastDataDate: string | null;
  /** Días con datos del dominio (cruce `site`) en cada ventana. */
  daysWithDataBefore: number;
  daysWithDataAfter: number;
}): SeoSiteChangeWindowState {
  const range = seoSiteChangeRange(input.changeDate, input.days);
  const availableOn = shiftDate(range.afterTo, SEO_GSC_FINAL_DELAY_DAYS);
  if (input.today < availableOn) {
    return { status: 'waiting', availableOn, daysLeft: daysBetween(input.today, availableOn) };
  }
  if (!input.lastDataDate || input.lastDataDate < range.afterTo) {
    return { status: 'waiting', availableOn, daysLeft: null };
  }
  if (!input.firstDataDate || input.firstDataDate > range.beforeFrom) {
    return { status: 'no_history', availableOn, daysLeft: null };
  }
  const before = seoPeriodCovered({
    firstDate: input.firstDataDate,
    from: range.beforeFrom,
    to: range.beforeTo,
    daysWithData: input.daysWithDataBefore,
  });
  const after = seoPeriodCovered({
    firstDate: input.firstDataDate,
    from: range.afterFrom,
    to: range.afterTo,
    daysWithData: input.daysWithDataAfter,
  });
  return { status: before && after ? 'ready' : 'incomplete', availableOn, daysLeft: null };
}

export const SEO_SITE_CHANGE_VERDICTS = ['better', 'worse', 'flat', 'insufficient'] as const;
export type SeoSiteChangeVerdict = (typeof SEO_SITE_CHANGE_VERDICTS)[number];
export const SEO_SITE_CHANGE_VERDICT_LABELS: Record<SeoSiteChangeVerdict, string> = {
  better: 'Mejora',
  worse: 'Empeora',
  flat: 'Sin cambio claro',
  insufficient: 'Pocos datos',
};

const signedPct = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${seoFmtInt(Math.abs(n))} %`;
const dec1 = (n: number) => (Math.round(Math.abs(n) * 10) / 10).toFixed(1).replace('.', ',');

/** Lo que cambió, en palabras: «+35 % de clics, −12 % de impresiones y 2,1 puestos arriba». */
function variationText(v: SeoChangeDto, before: SeoTotalsDto, after: SeoTotalsDto): string {
  const parts: string[] = [];
  if (v.clicksPct !== null) parts.push(`${signedPct(v.clicksPct)} de clics`);
  else if (after.clicks > 0) parts.push(`${seoFmtInt(after.clicks)} clics (antes ninguno)`);
  if (v.impressionsPct !== null) parts.push(`${signedPct(v.impressionsPct)} de impresiones`);
  if (v.positionDiff !== null && Math.abs(v.positionDiff) >= 0.1) {
    parts.push(
      `${dec1(v.positionDiff)} ${Math.abs(v.positionDiff) === 1 ? 'puesto' : 'puestos'} ${
        v.positionDiff > 0 ? 'arriba' : 'abajo'
      }`,
    );
  } else if (v.positionDiff !== null) {
    parts.push('la misma posición');
  }
  if (parts.length === 0) return `${seoFmtInt(before.clicks)} → ${seoFmtInt(after.clicks)} clics`;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

export interface SeoSiteChangeVerdictResult {
  verdict: SeoSiteChangeVerdict;
  variation: SeoChangeDto | null;
  /** El veredicto en palabras («coincide con», nunca «gracias a»). */
  text: string;
  /** Qué hizo el resto del sitio en las mismas fechas (si se sabe). */
  contextNote: string | null;
}

/**
 * Veredicto de una ventana: mejora, empeora o sin cambio claro, con un mínimo
 * de impresiones en cada lado. Pesan los clics (2), la posición (1) y las
 * impresiones (1); hace falta sumar 2 a favor o en contra. Al lado, el resto
 * del sitio, para no confundir con una subida o bajada de temporada.
 */
export function seoSiteChangeVerdict(input: {
  before: SeoTotalsDto;
  after: SeoTotalsDto;
  /** Totales del dominio en las mismas ventanas (referencia). */
  site?: { before: SeoTotalsDto; after: SeoTotalsDto } | null;
  minImpressions?: number;
}): SeoSiteChangeVerdictResult {
  const min = input.minImpressions ?? SEO_SITE_CHANGE_MIN_IMPRESSIONS;
  const { before, after } = input;
  const variation = seoChange(after, before);
  const siteVariation = input.site ? seoChange(input.site.after, input.site.before) : null;

  let verdict: SeoSiteChangeVerdict;
  let text: string;
  if (before.impressions === 0 && after.impressions >= min) {
    verdict = 'better';
    text = `Coincide con la llegada a Google: antes no salía y después suma ${seoFmtInt(
      after.impressions,
    )} impresiones y ${seoFmtInt(after.clicks)} clics.`;
  } else if (after.impressions === 0 && before.impressions >= min) {
    verdict = 'worse';
    text = `Coincide con la salida de Google: antes tenía ${seoFmtInt(
      before.impressions,
    )} impresiones y después ninguna.`;
  } else if (before.impressions < min || after.impressions < min) {
    verdict = 'insufficient';
    text = `Pocos datos para concluir (menos de ${seoFmtInt(min)} impresiones en ${
      before.impressions < min && after.impressions < min ? 'cada lado' : 'uno de los lados'
    }).`;
  } else {
    let score = 0;
    if (before.clicks + after.clicks >= 10) {
      if (variation.clicksPct === null) score += after.clicks > 0 ? 2 : 0;
      else if (variation.clicksPct >= 15) score += 2;
      else if (variation.clicksPct <= -15) score -= 2;
    }
    if (variation.positionDiff !== null) {
      if (variation.positionDiff >= 1) score += 1;
      else if (variation.positionDiff <= -1) score -= 1;
    }
    if (variation.impressionsPct !== null) {
      if (variation.impressionsPct >= 15) score += 1;
      else if (variation.impressionsPct <= -15) score -= 1;
    }
    verdict = score >= 2 ? 'better' : score <= -2 ? 'worse' : 'flat';
    const what = variationText(variation, before, after);
    text =
      verdict === 'better'
        ? `Coincide con una mejora: ${what}.`
        : verdict === 'worse'
          ? `Coincide con un empeoramiento: ${what}.`
          : `Sin cambio claro: ${what}.`;
  }

  let contextNote: string | null = null;
  if (siteVariation && siteVariation.clicksPct !== null) {
    const site = siteVariation.clicksPct;
    const own = variation.clicksPct;
    if (verdict === 'better' && site >= 10 && (own === null || site >= own - 5)) {
      contextNote = `Todo el sitio subió parecido (${signedPct(site)} de clics en las mismas fechas): puede ser temporada y no el cambio.`;
    } else if (verdict === 'worse' && site <= -10 && (own === null || site <= own + 5)) {
      contextNote = `Todo el sitio bajó parecido (${signedPct(site)} de clics en las mismas fechas): puede no tener que ver con el cambio.`;
    } else {
      contextNote = `El sitio entero, en las mismas fechas: ${signedPct(site)} de clics.`;
    }
  }
  return { verdict, variation, text, contextNote };
}

/** Una actuación reducida a lo que hace falta para ver si se solapa con otra. */
export interface SeoSiteChangeOverlapInput extends SeoSiteChangeScope {
  id: string;
  date: string;
  title: string;
  domainId: string | null;
}

/** Dos alcances se tocan si comparten URL o palabra; una actuación sin alcance es de todo el sitio. */
export function seoScopesIntersect(a: SeoSiteChangeScope, b: SeoSiteChangeScope): boolean {
  const aEmpty = a.urlKeys.length === 0 && a.keywords.length === 0;
  const bEmpty = b.urlKeys.length === 0 && b.keywords.length === 0;
  if (aEmpty || bEmpty) return true;
  const urls = new Set(a.urlKeys);
  const words = new Set(a.keywords);
  return b.urlKeys.some((u) => urls.has(u)) || b.keywords.some((k) => words.has(k));
}

/**
 * Otras actuaciones del mismo dominio con alcance común dentro de las dos
 * ventanas de una comparación: su resultado queda mezclado («resultado mezclado
 * con la actuación del …»).
 */
export function seoOverlappingChanges<T extends SeoSiteChangeOverlapInput>(
  target: SeoSiteChangeOverlapInput,
  others: readonly T[],
  days: number,
): T[] {
  const r = seoSiteChangeRange(target.date, days);
  return others
    .filter(
      (o) =>
        o.id !== target.id &&
        (o.domainId === null || target.domainId === null || o.domainId === target.domainId) &&
        o.date >= r.beforeFrom &&
        o.date <= r.afterTo &&
        seoScopesIntersect(target, o),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Totales de antes y después de un elemento del alcance (una URL, una palabra, todo). */
export interface SeoSiteChangeCompareDto {
  before: SeoTotalsDto;
  after: SeoTotalsDto;
  variation: SeoChangeDto | null;
  verdict: SeoSiteChangeVerdict;
  text: string;
}

export interface SeoSiteChangeItemDto extends SeoSiteChangeCompareDto {
  kind: 'url' | 'keyword';
  /** URL tal como se apuntó o palabra normalizada. */
  label: string;
}

export interface SeoSiteChangeOverlapDto {
  id: string;
  title: string;
  date: string;
}

export interface SeoSiteChangeWindowDto extends SeoSiteChangeRange {
  days: number;
  status: SeoSiteChangeWindowStatus;
  availableOn: string;
  daysLeft: number | null;
  /** El alcance entero (las URLs si las hay; si no, las palabras); null hasta que se pueda comparar. */
  scope: SeoSiteChangeCompareDto | null;
  /** El dominio entero en las mismas fechas. */
  site: { before: SeoTotalsDto; after: SeoTotalsDto; variation: SeoChangeDto | null } | null;
  contextNote: string | null;
  /** Por URL y por palabra (solo en la ficha). */
  items: SeoSiteChangeItemDto[];
  overlaps: SeoSiteChangeOverlapDto[];
}

export interface SeoSiteChangeDto {
  id: string;
  projectId: string;
  domainId: string | null;
  domain: string | null;
  date: string;
  time: string | null;
  changedAt: string;
  type: SeoSiteChangeType;
  title: string;
  description: string | null;
  urls: string[];
  keywords: string[];
  notes: string | null;
  createdByName: string | null;
  opportunityId: string | null;
  cannibalizationId: string | null;
  indexFindingId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  windows: SeoSiteChangeWindowDto[];
  createdAt: string;
  updatedAt: string;
}

export interface SeoSiteChangeListDto {
  items: SeoSiteChangeDto[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface SeoChartMarkerDto {
  id: string;
  date: string;
  title: string;
}

export interface SeoSiteChangeDetailDto extends SeoSiteChangeDto {
  /** Día a día del alcance (90 días antes y hasta 90 después, con lo que haya). */
  daily: SeoDashboardDayDto[];
  /** La propia actuación y las que se solapan con ella (marcas del gráfico). */
  markers: SeoChartMarkerDto[];
}

/** Rellena la descripción de una actuación propuesta desde lo que la motivó. */
export interface SeoSiteChangeDraftDto {
  type: SeoSiteChangeType;
  title: string;
  urls: string[];
  keywords: string[];
  domainId: string | null;
  opportunityId?: string | null;
  cannibalizationId?: string | null;
  indexFindingId?: string | null;
  taskId?: string | null;
}

// ------------------------------------------------------------------- tareas

export const SEO_TASK_TYPES = ['content', 'technical', 'links', 'local', 'other'] as const;
export type SeoTaskType = (typeof SEO_TASK_TYPES)[number];
export const SeoTaskTypeEnum = z.enum(SEO_TASK_TYPES);
export const SEO_TASK_TYPE_LABELS: Record<SeoTaskType, string> = {
  content: 'Contenido',
  technical: 'Técnica',
  links: 'Enlaces',
  local: 'SEO local',
  other: 'Otra',
};

export const SEO_TASK_STATUSES = ['todo', 'in_progress', 'review', 'done', 'cancelled'] as const;
export type SeoTaskStatus = (typeof SEO_TASK_STATUSES)[number];
export const SeoTaskStatusEnum = z.enum(SEO_TASK_STATUSES);
export const SEO_TASK_STATUS_LABELS: Record<SeoTaskStatus, string> = {
  todo: 'Por hacer',
  in_progress: 'En curso',
  review: 'En revisión',
  done: 'Hecha',
  cancelled: 'Cancelada',
};
/** Columnas del tablero (las canceladas, solo en la lista). */
export const SEO_TASK_BOARD_STATUSES: SeoTaskStatus[] = ['todo', 'in_progress', 'review', 'done'];
export const SEO_TASK_OPEN_STATUSES: SeoTaskStatus[] = ['todo', 'in_progress', 'review'];

export const SEO_TASK_PRIORITIES = ['high', 'medium', 'low'] as const;
export type SeoTaskPriority = (typeof SEO_TASK_PRIORITIES)[number];
export const SeoTaskPriorityEnum = z.enum(SEO_TASK_PRIORITIES);
export const SEO_TASK_PRIORITY_LABELS: Record<SeoTaskPriority, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

export const SEO_TASK_CSV_MAX = 5_000;
/** Tareas como mucho en una consulta del tablero o del calendario. */
export const SEO_TASK_LIST_MAX = 500;

const taskFields = {
  title: z.string().trim().min(2, 'Ponle un título').max(200),
  description: z.string().trim().max(4000).nullable(),
  type: SeoTaskTypeEnum,
  status: SeoTaskStatusEnum,
  priority: SeoTaskPriorityEnum,
  /** Persona del equipo del negocio (o super admin en la plataforma). */
  assignedToId: idField.nullable(),
  dueDate: dateField.nullable(),
  /** Para las de contenido: cuándo se publica. */
  publishDate: dateField.nullable(),
  domainId: idField.nullable(),
  url: z.string().trim().max(2000).nullable(),
  keywords: z.array(z.string().trim().min(1).max(200)).max(SEO_SITE_CHANGE_LIMITS.keywords),
  opportunityId: idField.nullable(),
  cannibalizationId: idField.nullable(),
  indexFindingId: idField.nullable(),
  /** La actuación que se registró al cerrarla. */
  changeId: idField.nullable(),
};

export const CreateSeoTaskSchema = z.object(taskFields).partial().required({ title: true });
export type CreateSeoTaskInput = z.infer<typeof CreateSeoTaskSchema>;

export const UpdateSeoTaskSchema = z
  .object(taskFields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'No hay nada que cambiar.',
  });
export type UpdateSeoTaskInput = z.infer<typeof UpdateSeoTaskSchema>;

/** Mover una tarea de columna o de puesto dentro de ella. */
export const MoveSeoTaskSchema = z.object({
  status: SeoTaskStatusEnum,
  /** Puesto en la columna de destino (0 = la primera). */
  index: z.number().int().min(0).max(10_000),
});
export type MoveSeoTaskInput = z.infer<typeof MoveSeoTaskSchema>;

/** Fecha que cuenta en el calendario: la límite y, si no hay, la de publicación. */
export function seoTaskDate(t: { dueDate: string | null; publishDate: string | null }) {
  return t.dueDate ?? t.publishDate;
}

export type SeoTaskDueState = 'overdue' | 'today' | 'soon' | null;

/** Atrasada, vence hoy o en los próximos 3 días (las cerradas, nada). */
export function seoTaskDueState(
  t: { status: SeoTaskStatus; dueDate: string | null; publishDate: string | null },
  today: string,
): SeoTaskDueState {
  if (t.status === 'done' || t.status === 'cancelled') return null;
  const d = seoTaskDate(t);
  if (!d) return null;
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  return daysBetween(today, d) <= 3 ? 'soon' : null;
}

/**
 * Orden de una columna tras mover una tarea a ella: se quita de donde estuviera
 * y se mete en el puesto pedido (si es mayor que la columna, al final).
 */
export function seoReorderColumn(ids: readonly string[], movedId: string, index: number): string[] {
  const rest = ids.filter((id) => id !== movedId);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), movedId, ...rest.slice(at)];
}

export interface SeoTaskDto {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  type: SeoTaskType;
  status: SeoTaskStatus;
  priority: SeoTaskPriority;
  assignedToId: string | null;
  assignedToName: string | null;
  dueDate: string | null;
  publishDate: string | null;
  domainId: string | null;
  domain: string | null;
  url: string | null;
  keywords: string[];
  opportunityId: string | null;
  cannibalizationId: string | null;
  indexFindingId: string | null;
  changeId: string | null;
  changeTitle: string | null;
  /** De dónde sale (para enseñarlo en la tarjeta). */
  sourceLabel: string | null;
  position: number;
  createdByName: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeoTaskListDto {
  items: SeoTaskDto[];
  /** Hoy en España (para atrasadas y «vence hoy»). */
  today: string;
  /** Hay más de las que caben (filtra). */
  truncated: boolean;
}

export function isSeoDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value);
}
