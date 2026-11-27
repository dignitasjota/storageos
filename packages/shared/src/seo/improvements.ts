import { z } from 'zod';

/**
 * SEO Avanzado: mejoras (2026-11-26). Lo puro de cada mejora: marca frente a no
 * marca, zonas, páginas en móvil, directorios de un competidor, importación de
 * CSV de SISTRIX y operaciones en lote de palabras. El API lee y escribe; aquí
 * se decide.
 */

/** Ruta de una URL (o de una ruta suelta), sin parámetros ni barra final. */
function pathOf(raw: string): string {
  const s = raw.trim().replace(/#.*$/, '');
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*(.*)$/i.exec(s);
  const rest = m ? (m[1] ?? '') : s;
  const q = rest.indexOf('?');
  let path = q >= 0 ? rest.slice(0, q) : rest;
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  return path;
}

/** Minúsculas, sin tildes y con los espacios normalizados (para comparar textos). */
export function seoPlainText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Dominio en minúsculas y sin `www.`. */
export function stripWwwDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

// ------------------------------------------------------- mejora 3: marca

export const SEO_BRAND_FILTERS = ['all', 'brand', 'nonbrand'] as const;
export type SeoBrandFilter = (typeof SEO_BRAND_FILTERS)[number];
export const SEO_BRAND_FILTER_LABELS: Record<SeoBrandFilter, string> = {
  all: 'Todas las búsquedas',
  brand: 'Solo de marca',
  nonbrand: 'Sin marca',
};

export const isSeoBrandFilter = (v: unknown): v is SeoBrandFilter =>
  typeof v === 'string' && (SEO_BRAND_FILTERS as readonly string[]).includes(v);

/** Términos de marca limpios (sin vacíos ni repetidos). */
export function seoBrandTerms(terms: readonly string[] | null | undefined): string[] {
  return [...new Set((terms ?? []).map((t) => seoPlainText(t)).filter((t) => t.length >= 2))];
}

/** ¿La búsqueda es de marca (contiene alguno de los términos)? */
export function isSeoBrandQuery(query: string, terms: readonly string[]): boolean {
  const q = seoPlainText(query);
  return seoBrandTerms(terms).some((t) => q.includes(t));
}

/** Patrones para `ILIKE` (con los comodines del usuario escapados). */
export function seoBrandLikePatterns(terms: readonly string[]): string[] {
  return seoBrandTerms(terms).map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
}

export interface SeoBrandSideDto {
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  previousClicks: number | null;
  previousImpressions: number | null;
  previousPosition: number | null;
  /** Parte de los clics con detalle (0-1). */
  clickShare: number | null;
}

export interface SeoBrandSplitDto {
  projectId: string;
  domainId: string | null;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  previousAvailable: boolean;
  /** El proyecto no tiene términos de marca: se invita a ponerlos. */
  needsTerms: boolean;
  terms: string[];
  brand: SeoBrandSideDto;
  nonBrand: SeoBrandSideDto;
}

// -------------------------------------------------------- mejora 5: zonas

export const UpdateSeoLocalAreasSchema = z.object({
  areas: z
    .array(z.string().trim().min(2).max(80))
    .max(60)
    .transform((list) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const a of list) {
        const key = seoPlainText(a);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(a.trim());
      }
      return out;
    }),
});
export type UpdateSeoLocalAreasInput = z.infer<typeof UpdateSeoLocalAreasSchema>;

/**
 * La zona que nombra una búsqueda («trasteros mislata» → «Mislata»). Compara
 * sin tildes ni mayúsculas y por palabras enteras; si dos zonas casan, la más
 * larga («Valencia» frente a «Ciudad de Valencia»).
 */
export function detectSeoArea(query: string, areas: readonly string[]): string | null {
  const q = ` ${seoPlainText(query)} `;
  let best: string | null = null;
  for (const area of areas) {
    const a = seoPlainText(area);
    if (!a) continue;
    if (q.includes(` ${a} `) && (best === null || a.length > seoPlainText(best).length)) {
      best = area;
    }
  }
  return best;
}

/** Patrones `ILIKE` de una zona: con y sin tildes. */
export function seoAreaLikePatterns(area: string): string[] {
  const esc = (t: string) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  const plain = seoPlainText(area);
  const raw = area.trim().toLowerCase();
  return [...new Set([esc(plain), esc(raw)])];
}

export type SeoAreaSuggestionSource = 'facility' | 'area_page';
export interface SeoAreaSuggestionDto {
  area: string;
  source: SeoAreaSuggestionSource;
}

export interface SeoAreasDto {
  projectId: string;
  areas: string[];
  /** Ciudades de los locales y páginas de zona del negocio (solo en un tenant). */
  suggestions: SeoAreaSuggestionDto[];
}

/** Zonas con búsquedas en Google y sin página propia (factor de la oportunidad). */
export const SEO_AREA_GAP_MIN_IMPRESSIONS = 30;

// ---------------------------------------------- mejora 11: móvil / ordenador

export interface SeoDeviceTotals {
  clicks: number;
  impressions: number;
  /** Posición media ponderada por impresiones. */
  position: number | null;
}

export interface SeoMobileGap {
  /** El móvil va claramente peor que el ordenador. */
  worse: boolean;
  ctrMobile: number | null;
  ctrDesktop: number | null;
  /** Puestos que pierde en móvil (positivo = peor en móvil). */
  positionGap: number | null;
  reason: string | null;
}

export const SEO_MOBILE_MIN_IMPRESSIONS = 100;

const pct = (n: number) => `${Math.round(n * 1000) / 10} %`.replace('.', ',');

/**
 * ¿La página va claramente peor en móvil? Hace falta volumen en los dos
 * lados; cuenta si su CTR en móvil es menos de la mitad (con una diferencia
 * de al menos un punto) o si baja 3 puestos o más.
 */
export function seoMobileGap(mobile: SeoDeviceTotals, desktop: SeoDeviceTotals): SeoMobileGap {
  const ctrM = mobile.impressions > 0 ? mobile.clicks / mobile.impressions : null;
  const ctrD = desktop.impressions > 0 ? desktop.clicks / desktop.impressions : null;
  const positionGap =
    mobile.position !== null && desktop.position !== null
      ? Math.round((mobile.position - desktop.position) * 10) / 10
      : null;
  const enough =
    mobile.impressions >= SEO_MOBILE_MIN_IMPRESSIONS &&
    desktop.impressions >= SEO_MOBILE_MIN_IMPRESSIONS;
  const reasons: string[] = [];
  if (enough && ctrM !== null && ctrD !== null && ctrM < ctrD * 0.5 && ctrD - ctrM >= 0.01) {
    reasons.push(`CTR en móvil ${pct(ctrM)} frente a ${pct(ctrD)} en ordenador`);
  }
  if (enough && positionGap !== null && positionGap >= 3) {
    reasons.push(`${String(positionGap).replace('.', ',')} puestos peor en móvil`);
  }
  return {
    worse: reasons.length > 0,
    ctrMobile: ctrM,
    ctrDesktop: ctrD,
    positionGap,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}

export interface SeoPageDeviceRowDto {
  page: string;
  mobile: SeoDeviceTotals & { ctr: number | null };
  desktop: SeoDeviceTotals & { ctr: number | null };
  worseOnMobile: boolean;
  reason: string | null;
  positionGap: number | null;
}

export interface SeoPageDevicesDto {
  projectId: string;
  from: string;
  to: string;
  total: number;
  items: SeoPageDeviceRowDto[];
  /** La URL de PageSpeed para medir la página en móvil se arma en la web. */
  hasData: boolean;
}

// ------------------------------------- mejora 14: competidores por directorio

/** Ruta de un directorio normalizada («/valencia/»): null si no vale o es la raíz. */
export function normalizeSeoPathPrefix(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return null;
  // Admite «competidor.es/valencia/» (quita el dominio) y «/valencia».
  const noHost = raw.replace(/^[a-z]+:\/\//, '').replace(/^[^/]*\.[a-z]{2,}(?=\/)/, '');
  const path = noHost.replace(/[?#].*$/, '');
  const clean = `/${path.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`.replace(/\/+$/, '');
  if (clean === '' || clean === '/') return null;
  if (!/^\/[a-z0-9._~%\-/]+$/.test(clean) || clean.length > 120) return null;
  return `${clean}/`;
}

/** ¿La URL cuelga del directorio? Sin directorio, toda URL vale. */
export function seoUrlInPath(url: string, prefix: string | null | undefined): boolean {
  if (!prefix) return true;
  const path = `${pathOf(url).toLowerCase().replace(/\/+$/, '')}/`;
  return path.startsWith(prefix);
}

// ------------------------------- mejora 13: parejas de idioma de una página

/**
 * Una URL de idioma (`/l/en/precios`) y su original (`/precios`): devuelve la
 * ruta sin el prefijo de idioma y el idioma (null = el de por defecto).
 */
export function seoSplitLocalePath(url: string): { path: string; locale: string | null } {
  const path = pathOf(url);
  const m = /^(.*?)\/l\/([a-z]{2}(?:-[a-z]{2})?)(\/.*)?$/i.exec(path);
  if (!m) return { path: path.toLowerCase(), locale: null };
  const prefix = m[1] ?? '';
  const rest = m[3] ?? '';
  return { path: `${prefix}${rest}`.toLowerCase() || '/', locale: (m[2] ?? '').toLowerCase() };
}

/** ¿Son dos versiones de idioma de la misma página? */
export function seoIsLanguagePair(a: string, b: string): boolean {
  const x = seoSplitLocalePath(a);
  const y = seoSplitLocalePath(b);
  return x.path === y.path && x.locale !== y.locale;
}

// ------------------------------------- mejora 8: CSV de SISTRIX

export const SEO_SISTRIX_CSV_KINDS = ['domain_keywords', 'serp', 'competitors'] as const;
export type SeoSistrixCsvKind = (typeof SEO_SISTRIX_CSV_KINDS)[number];
export const SEO_SISTRIX_CSV_KIND_LABELS: Record<SeoSistrixCsvKind, string> = {
  domain_keywords: 'Palabras de un dominio',
  serp: 'Resultados de una búsqueda',
  competitors: 'Competidores',
};
/** Tamaño y filas máximos de un CSV importado. */
export const SEO_SISTRIX_CSV_MAX_BYTES = 5 * 1024 * 1024;
export const SEO_SISTRIX_CSV_MAX_ROWS = 20_000;

export interface SeoSistrixCsvPreviewDto {
  kind: SeoSistrixCsvKind;
  filename: string;
  domain: string | null;
  keyword: string | null;
  country: string;
  /** Filas que se guardarían. */
  rows: number;
  /** Filas que ya estaban o no valen. */
  skipped: number;
  /** Primeras filas, para ver que se ha leído bien. */
  sample: { a: string; b: string; c: string }[];
  /** Cabeceras que no se han reconocido (para avisar). */
  warnings: string[];
}

export interface SeoSistrixImportDto {
  id: string;
  kind: SeoSistrixCsvKind;
  filename: string;
  domain: string | null;
  keyword: string | null;
  country: string;
  rows: number;
  skipped: number;
  createdAt: string;
  /** Quién la hizo (null = no se sabe). */
  createdBy: string | null;
}

// ------------------------------------- mejora 10: palabras en lote

export const BatchUpdateSeoKeywordsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(300),
    groupName: z.string().trim().max(80).nullable().optional(),
    priority: z.number().int().min(1).max(3).optional(),
    intent: z.string().trim().max(40).nullable().optional(),
    targetUrl: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (v) =>
      v.groupName !== undefined ||
      v.priority !== undefined ||
      v.intent !== undefined ||
      v.targetUrl !== undefined,
    { message: 'Elige qué cambiar.' },
  );
export type BatchUpdateSeoKeywordsInput = z.infer<typeof BatchUpdateSeoKeywordsSchema>;

export const RenameSeoKeywordGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type RenameSeoKeywordGroupInput = z.infer<typeof RenameSeoKeywordGroupSchema>;

export interface SeoBatchResultDto {
  updated: number;
}

// ------------------------------------- mejora 2: probar la API clásica

export const SEO_API_PROBE_METHODS = [
  'domain.kwcount.seo',
  'keyword.seo.metrics',
  'keyword.seo',
] as const;
export type SeoApiProbeMethod = (typeof SEO_API_PROBE_METHODS)[number];
export const SEO_API_PROBE_LABELS: Record<SeoApiProbeMethod, string> = {
  'domain.kwcount.seo': 'Palabras de un dominio (1 crédito)',
  'keyword.seo.metrics': 'Métricas de una palabra (5 créditos)',
  'keyword.seo': 'Resultados de Google de una palabra (10 créditos)',
};

export const ProbeSistrixApiSchema = z.object({
  method: z.enum(SEO_API_PROBE_METHODS).default('domain.kwcount.seo'),
  domain: z.string().trim().max(253).optional(),
  keyword: z.string().trim().max(200).optional(),
  country: z.string().trim().length(2).optional(),
});
export type ProbeSistrixApiInput = z.infer<typeof ProbeSistrixApiSchema>;

export interface SeoApiProbeResultDto {
  sampleId: string;
  method: string;
  /** Créditos que se anotaron (los de la respuesta, o la estimación si no los decía). */
  credits: number;
  /** La respuesta decía cuánto había gastado. */
  creditsKnown: boolean;
  /** Tipo de respuesta: datos, vacía o error. */
  outcome: 'ok' | 'empty' | 'error';
  message: string;
}

export interface SeoApiSampleDto {
  id: string;
  method: string;
  params: Record<string, unknown>;
  credits: number;
  creditsKnown: boolean;
  createdAt: string;
  /** Cuerpo de la respuesta tal cual la dio SISTRIX (para ver su forma). */
  response: unknown;
}

// ------------------------------- mejora 15: transparencia para el tenant

/** Lo que el tenant tiene que saber sobre la visibilidad en IA con su clave. */
export const SEO_AI_VISIBILITY_API_NOTE =
  'La visibilidad en buscadores de IA no se puede pedir con una clave de API de SISTRIX: solo está en la conexión (MCP) de la plataforma. Aquí verás lo que la plataforma tenga de tu web; con tu clave solo se consultan palabras, competidores y resultados de Google.';

// ------------------------------------------------- mejora 4: la competencia

export interface SeoCompetitionMoverDto {
  domain: string;
  /** Es tu dominio (no un competidor). */
  own: boolean;
  keyword: string;
  group: string | null;
  /** Posición en la muestra anterior (null = no salía). */
  previous: number | null;
  /** Posición en la última muestra (null = ya no sale). */
  current: number | null;
  /** Puestos que sube (positivo) o baja (negativo); null si entra o sale. */
  diff: number | null;
  url: string;
  title: string | null;
}

export interface SeoCompetitionDomainSummaryDto {
  domain: string;
  own: boolean;
  /** Palabras en las que sube, baja, entra o sale. */
  up: number;
  down: number;
  entered: number;
  left: number;
}

export interface SeoCompetitionMoversDto {
  projectId: string;
  /** Fechas de las muestras que se comparan (la más reciente y la anterior). */
  from: string | null;
  to: string | null;
  summary: SeoCompetitionDomainSummaryDto[];
  /** Los cambios más grandes (hasta 100). */
  items: SeoCompetitionMoverDto[];
  /** Palabras seguidas sin dos muestras de Google para comparar. */
  withoutHistory: number;
}

export interface SeoCompetitionGroupCellDto {
  domain: string;
  own: boolean;
  /** Palabras del grupo en las que sale (en el top 20 de las muestras). */
  appears: number;
  /** Posición media donde sale (null si no sale en ninguna). */
  averagePosition: number | null;
  best: number | null;
}

export interface SeoCompetitionGroupDto {
  group: string | null;
  keywords: number;
  /** Palabras del grupo con una muestra de Google. */
  sampled: number;
  cells: SeoCompetitionGroupCellDto[];
}

export interface SeoCompetitionGroupsDto {
  projectId: string;
  groups: SeoCompetitionGroupDto[];
}

export interface SeoCompetitionEvolutionPointDto {
  date: string;
  position: number | null;
  url: string | null;
  title: string | null;
}

export interface SeoCompetitionEvolutionDto {
  keyword: string;
  domain: string;
  own: boolean;
  /** Tus posiciones en la misma palabra, para compararlas. */
  mine: { date: string; position: number | null }[];
  points: SeoCompetitionEvolutionPointDto[];
}

// ----------------------------------------------- mejora 6: anotaciones

export interface SeoAnnotationProposalDto {
  /** Id del registro de actividad del que sale (no se duplica). */
  sourceRef: string;
  /** Tipo de la actuación propuesta (`SeoSiteChangeType`). */
  type: string;
  title: string;
  description: string | null;
  /** Día del cambio (YYYY-MM-DD, hora de España). */
  changeDate: string;
  changeTime: string | null;
  urls: string[];
  /** De dónde sale, en palabras («Cambio del título del SEO de la web»). */
  origin: string;
}

export interface SeoAnnotationProposalsDto {
  projectId: string;
  items: SeoAnnotationProposalDto[];
}

export const DismissSeoAnnotationSchema = z.object({
  sourceRefs: z.array(z.string().min(1).max(100)).min(1).max(100),
});
export type DismissSeoAnnotationInput = z.infer<typeof DismissSeoAnnotationSchema>;

// ------------------------------------ mejora 12: el año anterior

/** Aviso cuando no hay datos del mismo periodo del año anterior. */
export const SEO_YEAR_AGO_MISSING =
  'No hay histórico del año anterior para este periodo (Search Console solo guarda 16 meses; importa un Excel antiguo si lo tienes).';

/** «Baja» o «Sube» frente al mismo periodo del año anterior (mejora 12). */
export interface SeoOpportunityYearAgoDto {
  available: boolean;
  message: string | null;
  from: string;
  to: string;
  yearFrom: string;
  yearTo: string;
  /** Impresiones, clics y posición ahora y hace un año (null si no hay histórico). */
  current: { clicks: number; impressions: number; position: number | null } | null;
  yearAgo: { clicks: number; impressions: number; position: number | null } | null;
  /** Variación de las impresiones frente a hace un año (%). */
  impressionsPct: number | null;
  /** Puestos que sube (positivo) frente a hace un año. */
  positionDiff: number | null;
}
