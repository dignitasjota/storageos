import { z } from 'zod';

import { normalizeSeoUrl, splitSeoUrl } from './diagnostics';
import { seoFmtInt } from './opportunities';

import type { SeoAlertCandidate } from './alerts';

/**
 * SEO Avanzado, PR 9 (fase 4): lo que dice Google de una URL (inspección de
 * URL de Search Console) y lo rápida que es (PageSpeed Insights). Todo lo de
 * este fichero es puro: la cuota del día, qué se inspecciona en el lote
 * programado, cómo se lee el veredicto de Google y las alertas nuevas.
 */

// ------------------------------------------------------------------ cuota

/**
 * Límites de la URL Inspection API (documentación de Google, «Usage limits»):
 * 2.000 consultas al día y 600 al minuto por propiedad.
 */
export const SEO_INSPECTION_GOOGLE_DAILY_LIMIT = 2000;
export const SEO_INSPECTION_GOOGLE_PER_MINUTE = 600;
/**
 * Google no dice a qué hora reinicia la cuota de la inspección; las cuotas
 * diarias de las APIs de Google se reinician a medianoche de la hora del
 * Pacífico, y es la que se usa para contar el día.
 */
export const SEO_INSPECTION_QUOTA_TIMEZONE = 'America/Los_Angeles';
/** Una inspección de hace más días ya no cuenta como «reciente». */
export const SEO_INSPECTION_RECENT_DAYS = 30;

/** Día de la cuota (AAAA-MM-DD en la hora del Pacífico). */
export function seoQuotaDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SEO_INSPECTION_QUOTA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Hora del Pacífico de un instante (0-23). */
function pacificHour(d: Date): number {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: SEO_INSPECTION_QUOTA_TIMEZONE,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(d);
  return Number(h) % 24;
}

/** Cuándo se reinicia la cuota (la próxima medianoche del Pacífico). */
export function seoNextQuotaReset(now: Date = new Date()): Date {
  const day = seoQuotaDay(now);
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  // Medianoche del Pacífico es las 08:00 UTC en invierno y las 07:00 en verano.
  const guess = new Date(next.getTime() + 8 * 3600_000);
  const h = pacificHour(guess);
  return new Date(guess.getTime() - (h === 0 ? 0 : h > 12 ? h - 24 : h) * 3600_000);
}

export interface SeoInspectionQuotaState {
  used: number;
  cap: number;
  /** Lo que queda hoy: lo menor entre tu tope y lo que deja Google en la propiedad. */
  remaining: number;
  /** Lo que lleva la propiedad hoy (puede usarla otro proyecto). */
  propertyUsed: number;
}

export function seoInspectionQuota(input: {
  usedByProject: number;
  usedByProperty: number;
  cap: number;
}): SeoInspectionQuotaState {
  const remaining = Math.max(
    0,
    Math.min(
      input.cap - input.usedByProject,
      SEO_INSPECTION_GOOGLE_DAILY_LIMIT - input.usedByProperty,
    ),
  );
  return {
    used: input.usedByProject,
    cap: input.cap,
    remaining,
    propertyUsed: input.usedByProperty,
  };
}

// ---------------------------------------------------------------- ajustes

export type SeoTechnicalScope = 'tenant' | 'platform';

export interface SeoTechnicalSettings {
  /** Tope de inspecciones al día del proyecto (Google deja 2.000 por propiedad). */
  inspectionDailyCap: number;
  /** Lote programado: se inspeccionan solas las URL importantes. */
  inspectionBatchEnabled: boolean;
  /** Una URL no se vuelve a inspeccionar en el lote antes de estos días. */
  inspectionReinspectDays: number;
  /** URL como mucho en cada lote diario. */
  inspectionBatchMax: number;
  /** Medición semanal de la velocidad (PageSpeed). */
  pagespeedEnabled: boolean;
  /** URL que se miden cada semana (cada una, en móvil y en ordenador). */
  pagespeedMaxUrls: number;
}

export const SEO_TECHNICAL_DEFAULTS: Record<SeoTechnicalScope, SeoTechnicalSettings> = {
  tenant: {
    inspectionDailyCap: 200,
    inspectionBatchEnabled: false,
    inspectionReinspectDays: 14,
    inspectionBatchMax: 50,
    pagespeedEnabled: true,
    pagespeedMaxUrls: 10,
  },
  platform: {
    inspectionDailyCap: 1000,
    inspectionBatchEnabled: false,
    inspectionReinspectDays: 14,
    inspectionBatchMax: 200,
    pagespeedEnabled: true,
    pagespeedMaxUrls: 20,
  },
};

type NumericKey = Exclude<
  keyof SeoTechnicalSettings,
  'inspectionBatchEnabled' | 'pagespeedEnabled'
>;

export const SEO_TECHNICAL_RANGES: Record<
  SeoTechnicalScope,
  Record<NumericKey, { min: number; max: number; label: string }>
> = {
  tenant: {
    inspectionDailyCap: { min: 1, max: 1000, label: 'Inspecciones al día como mucho' },
    inspectionReinspectDays: { min: 1, max: 90, label: 'Días antes de volver a inspeccionar' },
    inspectionBatchMax: { min: 1, max: 500, label: 'URL en cada lote' },
    pagespeedMaxUrls: { min: 1, max: 30, label: 'URL medidas cada semana' },
  },
  platform: {
    inspectionDailyCap: {
      min: 1,
      max: SEO_INSPECTION_GOOGLE_DAILY_LIMIT,
      label: 'Inspecciones al día como mucho',
    },
    inspectionReinspectDays: { min: 1, max: 90, label: 'Días antes de volver a inspeccionar' },
    inspectionBatchMax: { min: 1, max: 1000, label: 'URL en cada lote' },
    pagespeedMaxUrls: { min: 1, max: 50, label: 'URL medidas cada semana' },
  },
};

/** Ajustes guardados con los valores por defecto donde falten. */
export function seoTechnicalSettingsOf(
  stored: unknown,
  scope: SeoTechnicalScope,
): SeoTechnicalSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out = { ...SEO_TECHNICAL_DEFAULTS[scope] };
  for (const k of Object.keys(SEO_TECHNICAL_RANGES[scope]) as NumericKey[]) {
    const v = s[k];
    const r = SEO_TECHNICAL_RANGES[scope][k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.min(r.max, Math.max(r.min, Math.round(v)));
    }
  }
  if (typeof s.inspectionBatchEnabled === 'boolean')
    out.inspectionBatchEnabled = s.inspectionBatchEnabled;
  if (typeof s.pagespeedEnabled === 'boolean') out.pagespeedEnabled = s.pagespeedEnabled;
  return out;
}

export const UpdateSeoTechnicalSettingsSchema = z
  .object({
    inspectionDailyCap: z.number().int().min(1).max(SEO_INSPECTION_GOOGLE_DAILY_LIMIT),
    inspectionBatchEnabled: z.boolean(),
    inspectionReinspectDays: z.number().int().min(1).max(90),
    inspectionBatchMax: z.number().int().min(1).max(1000),
    pagespeedEnabled: z.boolean(),
    pagespeedMaxUrls: z.number().int().min(1).max(50),
    /** Vuelve a los valores por defecto. */
    reset: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateSeoTechnicalSettingsInput = z.infer<typeof UpdateSeoTechnicalSettingsSchema>;

// ----------------------------------------------------------------- URL

/** Una URL pedida a mano: absoluta (http o https) o una ruta del dominio principal. */
export const InspectSeoUrlSchema = z.object({
  url: z.string().trim().min(1).max(2000),
});
export type InspectSeoUrlInput = z.infer<typeof InspectSeoUrlSchema>;

/**
 * URL absoluta a partir de lo que se guarda (las URL objetivo pueden ser una
 * ruta, «/precios», que vale en cualquier dominio del proyecto).
 */
export function seoAbsoluteUrl(raw: string, domain: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return s;
  // «ejemplo.es/precios»: con su dominio.
  if (!s.startsWith('/') && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s)) return `https://${s}`;
  const path = s.startsWith('/') ? s : `/${s}`;
  return `https://${domain}${path}`;
}

/** Clave para buscar la última inspección de una URL (absoluta o ruta del dominio). */
export function seoInspectionUrlKey(raw: string, domain: string): string {
  return normalizeSeoUrl(seoAbsoluteUrl(raw, domain));
}

/** Host de una URL sin `www.` (vacío si es una ruta). */
export const seoUrlHost = (raw: string) => splitSeoUrl(raw).host;

// ------------------------------------------------------ resultado de Google

export const SEO_INSPECTION_VERDICT_LABELS: Record<string, string> = {
  PASS: 'Válida',
  PARTIAL: 'Parcial',
  FAIL: 'Con errores',
  NEUTRAL: 'Excluida',
  VERDICT_UNSPECIFIED: 'Sin datos',
};

export const SEO_PAGE_FETCH_LABELS: Record<string, string> = {
  SUCCESSFUL: 'Se pudo leer',
  SOFT_404: 'Parece una página vacía o de error (404 suave)',
  BLOCKED_ROBOTS_TXT: 'Bloqueada por robots.txt',
  NOT_FOUND: 'No existe (404)',
  ACCESS_DENIED: 'Pide identificarse (401)',
  SERVER_ERROR: 'Error del servidor (5xx)',
  REDIRECT_ERROR: 'Error en la redirección',
  ACCESS_FORBIDDEN: 'Acceso prohibido (403)',
  BLOCKED_4XX: 'Bloqueada por otro error 4xx',
  INTERNAL_CRAWL_ERROR: 'Error interno de Google al leerla',
  INVALID_URL: 'URL no válida',
  PAGE_FETCH_STATE_UNSPECIFIED: 'Sin datos',
};

export const SEO_INDEXING_STATE_LABELS: Record<string, string> = {
  INDEXING_ALLOWED: 'Se deja indexar',
  BLOCKED_BY_META_TAG: 'Tiene la etiqueta «noindex»',
  BLOCKED_BY_HTTP_HEADER: 'Tiene «noindex» en la cabecera HTTP',
  BLOCKED_BY_ROBOTS_TXT: 'Bloqueada por robots.txt',
  INDEXING_STATE_UNSPECIFIED: 'Sin datos',
};

export const SEO_ROBOTS_STATE_LABELS: Record<string, string> = {
  ALLOWED: 'Permitida en robots.txt',
  DISALLOWED: 'Bloqueada en robots.txt',
  ROBOTS_TXT_STATE_UNSPECIFIED: 'Sin datos',
};

export const SEO_CRAWLED_AS_LABELS: Record<string, string> = {
  MOBILE: 'Rastreador para móvil',
  DESKTOP: 'Rastreador para ordenador',
  CRAWLING_USER_AGENT_UNSPECIFIED: 'Sin datos',
};

/**
 * ¿Google la tiene en su índice? `PASS` = sí; `NEUTRAL` (excluida) y `FAIL`
 * (con errores) = no; sin veredicto, no se sabe.
 */
export function seoInspectionIndexed(verdict: string | null | undefined): boolean | null {
  if (verdict === 'PASS') return true;
  if (verdict === 'NEUTRAL' || verdict === 'FAIL' || verdict === 'PARTIAL') return false;
  return null;
}

/** Por qué no está indexada, en palabras (lo más concreto primero). */
export function seoNotIndexedReason(r: {
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  coverageState: string | null;
  canonicalMismatch: boolean;
}): string {
  if (r.robotsTxtState === 'DISALLOWED') return 'Bloqueada en robots.txt';
  if (
    r.indexingState &&
    r.indexingState !== 'INDEXING_ALLOWED' &&
    SEO_INDEXING_STATE_LABELS[r.indexingState] &&
    r.indexingState !== 'INDEXING_STATE_UNSPECIFIED'
  ) {
    return SEO_INDEXING_STATE_LABELS[r.indexingState]!;
  }
  if (
    r.pageFetchState &&
    !['SUCCESSFUL', 'PAGE_FETCH_STATE_UNSPECIFIED'].includes(r.pageFetchState)
  ) {
    return SEO_PAGE_FETCH_LABELS[r.pageFetchState] ?? r.pageFetchState;
  }
  if (r.canonicalMismatch) return 'Google ha elegido otra URL como canónica';
  return r.coverageState?.trim() || 'Google no la tiene en su índice';
}

/**
 * Canónica que elige Google distinta de la declarada (o, sin canónica
 * declarada, distinta de la propia URL: Google la trata como duplicada).
 */
export function seoCanonicalMismatch(input: {
  url: string;
  googleCanonical: string | null;
  userCanonical: string | null;
}): boolean {
  if (!input.googleCanonical) return false;
  const declared = input.userCanonical || input.url;
  return normalizeSeoUrl(input.googleCanonical) !== normalizeSeoUrl(declared);
}

const fmtDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/** Lo que dice Google de una URL, en una línea (la etiqueta de Indexación). */
export function seoIndexStatusLabel(s: {
  indexed: boolean | null;
  inspectedAt: string;
  reason: string | null;
}): string {
  if (s.indexed === true) return `Indexación confirmada (${fmtDate(s.inspectedAt)})`;
  if (s.indexed === false)
    return `Google dice que no está indexada (${s.reason ?? 'sin motivo'}, ${fmtDate(s.inspectedAt)})`;
  return `Google no da veredicto (${fmtDate(s.inspectedAt)})`;
}

/** ¿La inspección es reciente (de los últimos 30 días)? */
export function seoInspectionRecent(inspectedAt: string, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(inspectedAt) <= SEO_INSPECTION_RECENT_DAYS * 86_400_000;
}

// --------------------------------------------------- lote programado

/** Por qué se inspecciona una URL. */
export const SEO_INSPECTION_REASONS = [
  'manual',
  'target_high',
  'index_finding',
  'top_clicks',
] as const;
export type SeoInspectionReason = (typeof SEO_INSPECTION_REASONS)[number];
export const SEO_INSPECTION_REASON_LABELS: Record<SeoInspectionReason, string> = {
  manual: 'A mano',
  target_high: 'URL objetivo de una palabra importante',
  index_finding: 'Página que no debería estar en Google',
  top_clicks: 'De las páginas con más clics',
};
const REASON_RANK: Record<SeoInspectionReason, number> = {
  manual: 0,
  target_high: 1,
  index_finding: 2,
  top_clicks: 3,
};

export interface SeoInspectionBatchItem {
  url: string;
  urlKey: string;
  reason: SeoInspectionReason;
}

/**
 * Qué URL entran en el lote de hoy: las URL objetivo de las palabras de
 * prioridad alta, los hallazgos de indexación abiertos y las páginas con más
 * clics, sin repetir (una misma página con otra forma es la misma), sin las
 * inspeccionadas hace menos de `reinspectDays` días ni las que ya esperan, y
 * sin pasar de `max` ni de lo que queda de cuota.
 */
export function selectSeoInspectionBatch(input: {
  candidates: readonly { url: string; reason: SeoInspectionReason }[];
  /** Última inspección hecha de cada URL (clave normalizada → ISO). */
  lastInspected: ReadonlyMap<string, string>;
  /** URL que ya esperan en la cola. */
  pending: ReadonlySet<string>;
  now: Date;
  reinspectDays: number;
  max: number;
  remaining: number;
}): SeoInspectionBatchItem[] {
  const limit = Math.max(0, Math.min(input.max, input.remaining));
  if (limit === 0) return [];
  const sorted = input.candidates
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.i - b.i);
  const out: SeoInspectionBatchItem[] = [];
  const seen = new Set<string>();
  const cutoff = input.now.getTime() - input.reinspectDays * 86_400_000;
  for (const c of sorted) {
    const urlKey = normalizeSeoUrl(c.url);
    if (!/^https?:\/\//i.test(c.url.trim()) || seen.has(urlKey)) continue;
    seen.add(urlKey);
    if (input.pending.has(urlKey)) continue;
    const last = input.lastInspected.get(urlKey);
    if (last && Date.parse(last) > cutoff) continue;
    out.push({ url: c.url.trim(), urlKey, reason: c.reason });
    if (out.length >= limit) break;
  }
  return out;
}

// ----------------------------------------------------------- PageSpeed

export const SEO_PAGESPEED_STRATEGIES = ['mobile', 'desktop'] as const;
export type SeoPageSpeedStrategy = (typeof SEO_PAGESPEED_STRATEGIES)[number];
export const SEO_PAGESPEED_STRATEGY_LABELS: Record<SeoPageSpeedStrategy, string> = {
  mobile: 'Móvil',
  desktop: 'Ordenador',
};

export const RunSeoPageSpeedSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  strategies: z.array(z.enum(SEO_PAGESPEED_STRATEGIES)).min(1).max(2).optional(),
});
export type RunSeoPageSpeedInput = z.infer<typeof RunSeoPageSpeedSchema>;

/** Métricas de Core Web Vitals y de laboratorio, con sus umbrales (bien / mejorable). */
export const SEO_CWV_THRESHOLDS = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  tbt: [200, 600],
  si: [3400, 5800],
  tti: [3800, 7300],
} as const;
export type SeoCwvMetric = keyof typeof SEO_CWV_THRESHOLDS;
export type SeoCwvRating = 'good' | 'needs_improvement' | 'poor';
export const SEO_CWV_RATING_LABELS: Record<SeoCwvRating, string> = {
  good: 'Bien',
  needs_improvement: 'Mejorable',
  poor: 'Lenta',
};

export function seoCwvRating(metric: SeoCwvMetric, value: number | null): SeoCwvRating | null {
  if (value === null || !Number.isFinite(value)) return null;
  const [good, ni] = SEO_CWV_THRESHOLDS[metric];
  return value <= good ? 'good' : value <= ni ? 'needs_improvement' : 'poor';
}

/** Puntuación de Lighthouse (0-100): 90 o más, bien; 50 o más, mejorable. */
export function seoScoreRating(score: number | null): SeoCwvRating | null {
  if (score === null) return null;
  return score >= 90 ? 'good' : score >= 50 ? 'needs_improvement' : 'poor';
}

/** Qué mide cada métrica, en una frase. */
export const SEO_CWV_HELP: Record<SeoCwvMetric, string> = {
  lcp: 'LCP: cuánto tarda en verse lo más grande de la página (la foto o el titular). Bien, por debajo de 2,5 segundos.',
  inp: 'INP: cuánto tarda la página en reaccionar cuando tocas o pulsas algo. Bien, por debajo de 200 milisegundos.',
  cls: 'CLS: cuánto se mueven las cosas mientras carga (botones que saltan). Bien, por debajo de 0,1.',
  fcp: 'FCP: cuánto tarda en aparecer lo primero en la pantalla.',
  tbt: 'TBT: tiempo en que la página está «ocupada» y no responde mientras carga.',
  si: 'Speed Index: lo rápido que se va llenando la pantalla.',
  tti: 'TTI: cuándo se puede usar la página del todo.',
};

/** Categoría de los datos de campo (usuarios reales de Chrome). */
export const SEO_FIELD_CATEGORIES = ['FAST', 'AVERAGE', 'SLOW', 'NONE'] as const;
export type SeoFieldCategory = (typeof SEO_FIELD_CATEGORIES)[number];
export const SEO_FIELD_CATEGORY_LABELS: Record<SeoFieldCategory, string> = {
  FAST: 'Rápida',
  AVERAGE: 'Mejorable',
  SLOW: 'Lenta',
  NONE: 'Sin datos',
};

export interface SeoPageSpeedFieldDto {
  /** De esta URL o, si no hay bastantes visitas, del sitio entero. */
  scope: 'url' | 'origin';
  overall: SeoFieldCategory | null;
  lcpMs: number | null;
  lcpCategory: SeoFieldCategory | null;
  inpMs: number | null;
  inpCategory: SeoFieldCategory | null;
  cls: number | null;
  clsCategory: SeoFieldCategory | null;
}

export interface SeoPageSpeedOpportunityDto {
  id: string;
  title: string;
  /** Ahorro estimado (ms) si lo da PageSpeed. */
  savingsMs: number | null;
  displayValue: string | null;
}

export type SeoPageSpeedStatus = 'queued' | 'running' | 'done' | 'error';
export type SeoTechnicalTrigger = 'manual' | 'batch';

export interface SeoPageSpeedRunDto {
  id: string;
  url: string;
  strategy: SeoPageSpeedStrategy;
  status: SeoPageSpeedStatus;
  trigger: SeoTechnicalTrigger;
  /** Puntuaciones 0-100 (null si no se midió). */
  scores: {
    performance: number | null;
    seo: number | null;
    accessibility: number | null;
    bestPractices: number | null;
  };
  /** Laboratorio (una carga simulada de Lighthouse). */
  lab: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
    fcpMs: number | null;
    siMs: number | null;
    ttiMs: number | null;
  };
  /** Campo: usuarios reales de Chrome (últimos 28 días), si Google tiene bastantes. */
  field: SeoPageSpeedFieldDto | null;
  opportunities: SeoPageSpeedOpportunityDto[];
  error: string | null;
  analyzedAt: string | null;
  createdAt: string;
}

/**
 * Qué URL se miden cada semana: la portada, las URL objetivo de prioridad
 * alta y las páginas con más clics, sin repetir y hasta `max`.
 */
export function selectSeoPageSpeedUrls(input: {
  home: string | null;
  targets: readonly string[];
  topPages: readonly string[];
  max: number;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of [input.home, ...input.targets, ...input.topPages]) {
    if (!u || !/^https?:\/\//i.test(u)) continue;
    const k = normalizeSeoUrl(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
    if (out.length >= input.max) break;
  }
  return out;
}

// --------------------------------------------------------------- alertas

/**
 * Alertas que salen de la inspección: la URL objetivo de una palabra seguida
 * que Google dice que no tiene, y la canónica que elige Google distinta de
 * la declarada. Solo con la última inspección reciente de cada URL.
 */
export function seoInspectionAlerts(input: {
  inspections: readonly {
    url: string;
    urlKey: string;
    inspectedAt: string;
    indexed: boolean | null;
    reason: string | null;
    canonicalMismatch: boolean;
    googleCanonical: string | null;
  }[];
  /** URL objetivo (clave normalizada) → palabras seguidas que la usan y si alguna es de prioridad alta. */
  targets: ReadonlyMap<string, { keywords: string[]; high: boolean }>;
  now: Date;
}): SeoAlertCandidate[] {
  const out: SeoAlertCandidate[] = [];
  for (const i of input.inspections) {
    if (!seoInspectionRecent(i.inspectedAt, input.now)) continue;
    const target = input.targets.get(i.urlKey);
    if (target && i.indexed === false) {
      const words = target.keywords
        .slice(0, 3)
        .map((k) => `«${k}»`)
        .join(', ');
      out.push({
        type: 'target_not_indexed',
        key: `target_not_indexed|${i.urlKey}`,
        severity: target.high ? 'high' : 'medium',
        title: `Google dice que no tiene indexada la URL objetivo ${i.url}`,
        message: `Es la página que quieres que salga para ${words}. Motivo: ${i.reason ?? 'sin detallar'} (inspección del ${fmtDate(i.inspectedAt)}).`,
        data: {
          url: i.url,
          keywords: target.keywords,
          reason: i.reason,
          inspectedAt: i.inspectedAt,
        },
      });
    }
    if (i.canonicalMismatch) {
      out.push({
        type: 'canonical_mismatch',
        key: `canonical_mismatch|${i.urlKey}`,
        severity: target ? 'high' : 'medium',
        title: `Google ha elegido otra canónica para ${i.url}`,
        message: `Google usa ${i.googleCanonical ?? '—'} como la versión buena. Revisa la etiqueta canónica, las redirecciones y los enlaces internos (inspección del ${fmtDate(i.inspectedAt)}).`,
        data: { url: i.url, googleCanonical: i.googleCanonical, inspectedAt: i.inspectedAt },
      });
    }
  }
  return out;
}

/**
 * Alertas de velocidad de una URL y estrategia: los usuarios reales la ven
 * «lenta», o su puntuación de rendimiento ha caído `dropPoints` o más frente
 * a la medición anterior.
 */
export function seoPageSpeedAlerts(input: {
  url: string;
  urlKey: string;
  strategy: SeoPageSpeedStrategy;
  latest: { performance: number | null; fieldOverall: SeoFieldCategory | null; analyzedAt: string };
  previous: { performance: number | null } | null;
  dropPoints: number;
}): SeoAlertCandidate[] {
  const out: SeoAlertCandidate[] = [];
  const label = SEO_PAGESPEED_STRATEGY_LABELS[input.strategy].toLowerCase();
  if (input.latest.fieldOverall === 'SLOW') {
    out.push({
      type: 'pagespeed_slow',
      key: `pagespeed_slow|${input.urlKey}|${input.strategy}`,
      severity: input.strategy === 'mobile' ? 'high' : 'medium',
      title: `Los usuarios reales ven lenta ${input.url} (${label})`,
      message: `Datos de campo de Chrome (últimos 28 días) del ${fmtDate(input.latest.analyzedAt)}: la página no pasa las Core Web Vitals. Mira las mejoras sugeridas en «Velocidad».`,
      data: { url: input.url, strategy: input.strategy },
    });
  }
  const now = input.latest.performance;
  const before = input.previous?.performance ?? null;
  if (now !== null && before !== null && before - now >= input.dropPoints) {
    out.push({
      type: 'pagespeed_drop',
      key: `pagespeed_drop|${input.urlKey}|${input.strategy}`,
      severity: before - now >= input.dropPoints * 2 ? 'high' : 'medium',
      title: `La puntuación de velocidad de ${input.url} (${label}) ha bajado ${seoFmtInt(before - now)} puntos`,
      message: `De ${seoFmtInt(before)} a ${seoFmtInt(now)} sobre 100 en la última medición de PageSpeed (${fmtDate(input.latest.analyzedAt)}). Puede ser un cambio en la página o una medición puntual: vuelve a medirla.`,
      data: { url: input.url, strategy: input.strategy, before, now },
    });
  }
  return out;
}

// ------------------------------------------------------------------ DTOs

export type SeoInspectionStatus = 'queued' | 'running' | 'done' | 'error';

/** Lo que dice Google de una URL (la última inspección hecha). */
export interface SeoUrlIndexStatusDto {
  url: string;
  inspectedAt: string;
  indexed: boolean | null;
  verdict: string | null;
  /** Motivo si no está indexada. */
  reason: string | null;
  label: string;
  googleCanonical: string | null;
  userCanonical: string | null;
  canonicalMismatch: boolean;
  lastCrawlAt: string | null;
  /** Hace más de 30 días: puede haber cambiado. */
  stale: boolean;
}

export interface SeoUrlInspectionDto {
  id: string;
  url: string;
  domain: string;
  status: SeoInspectionStatus;
  trigger: SeoTechnicalTrigger;
  reason: SeoInspectionReason;
  /** Espera a que se reinicie la cuota (o a su turno en la cola). */
  scheduledFor: string | null;
  inspectedAt: string | null;
  verdict: string | null;
  indexed: boolean | null;
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  crawledAs: string | null;
  lastCrawlAt: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  canonicalMismatch: boolean;
  notIndexedReason: string | null;
  sitemaps: string[];
  referringUrls: string[];
  mobileUsability: { verdict: string | null; issues: string[] } | null;
  richResults: { verdict: string | null; types: string[]; issues: string[] } | null;
  /** Enlace a la inspección en Search Console. */
  link: string | null;
  error: string | null;
  createdAt: string;
}

export interface SeoInspectionQuotaDto extends SeoInspectionQuotaState {
  day: string;
  googleLimit: number;
  resetsAt: string;
  /** Esperando en la cola (con cuota) y esperando al día siguiente. */
  queued: number;
  waitingNextDay: number;
}

export interface SeoInspectionsDto {
  quota: SeoInspectionQuotaDto;
  settings: SeoTechnicalSettings;
  /** La última inspección de cada URL (o la que espera). */
  items: SeoUrlInspectionDto[];
  summary: { urls: number; indexed: number; notIndexed: number; canonicalMismatch: number };
}

export interface SeoInspectResultDto {
  inspection: SeoUrlInspectionDto;
  /** No quedaba cuota: espera al día siguiente. */
  deferred: boolean;
  message: string;
}

export interface SeoInspectionHistoryDto {
  url: string;
  items: SeoUrlInspectionDto[];
}

export interface SeoPageSpeedUrlDto {
  url: string;
  mobile: SeoPageSpeedRunDto | null;
  desktop: SeoPageSpeedRunDto | null;
}

export interface SeoPageSpeedDto {
  settings: SeoTechnicalSettings;
  /** Hay clave de PageSpeed (sin ella la cuota de Google es muy baja). */
  keyConfigured: boolean;
  urls: SeoPageSpeedUrlDto[];
  /** Mediciones en cola o en curso. */
  pending: number;
  lastScheduledAt: string | null;
}

export interface SeoPageSpeedHistoryDto {
  url: string;
  strategy: SeoPageSpeedStrategy;
  runs: SeoPageSpeedRunDto[];
}

export const SEO_PAGESPEED_HISTORY_MAX = 52;
export const SEO_INSPECTION_LIST_MAX = 500;
