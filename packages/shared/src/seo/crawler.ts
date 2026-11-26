import { z } from 'zod';

import {
  normalizeSeoUrl,
  seoIndexRuleMatches,
  splitSeoUrl,
  type SeoDiagnosticStatus,
  type SeoIndexCategory,
  type SeoSeverity,
} from './diagnostics';
import { seoFmtInt } from './opportunities';
import { normalizeSeoKeyword } from './sistrix';

import type { SeoAlertCandidate } from './alerts';
import type { SeoUrlIndexStatusDto } from './inspection';

/**
 * SEO Avanzado, PR 10 (fase 4): rastreador propio de las webs del proyecto
 * (§9, §11, §15.4, §18.7 y §19.5). Un rastreador ligero (peticiones HTTP, sin
 * navegador sin cabeza: las webs se sirven ya renderizadas en el servidor)
 * que solo pide páginas de los dominios del proyecto, respeta su robots.txt y
 * sigue los enlaces internos desde la portada y los mapas del sitio.
 *
 * Todo lo de este fichero es puro: el API descarga y lee el HTML, y aquí se
 * decide qué es una incidencia, qué bloquea robots.txt, la profundidad de
 * cada página y lo que confirma el rastreo de un hallazgo de indexación.
 */

// ---------------------------------------------------------------- límites

/** Agente de usuario propio e identificable (la página explica qué hace). */
export const SEO_CRAWLER_USER_AGENT =
  'TrasterOS-SEO-Crawler/1.0 (+https://trasteros.pro/rastreador)';
/** Nombre con el que se le puede dar reglas en robots.txt. */
export const SEO_CRAWLER_ROBOTS_TOKEN = 'trasteros-seo-crawler';
/** Redirecciones que se siguen como mucho en una petición. */
export const SEO_CRAWL_MAX_REDIRECTS = 5;
/** Tamaño máximo de una respuesta (se corta la descarga). */
export const SEO_CRAWL_MAX_BYTES = 3 * 1024 * 1024;
/** Tiempo máximo de una petición. */
export const SEO_CRAWL_REQUEST_TIMEOUT_MS = 15_000;
/** Rastreos de cada proyecto que conservan sus páginas (los anteriores, solo el resumen). */
export const SEO_CRAWL_KEEP = 10;
/** Mapas del sitio que se leen como mucho (índices incluidos). */
export const SEO_CRAWL_MAX_SITEMAPS = 20;
/** Una respuesta más lenta que esto es una incidencia. */
export const SEO_CRAWL_SLOW_MS = 3000;
/** Profundidad de clic desde la portada a partir de la que una página queda lejos. */
export const SEO_CRAWL_DEEP_DEPTH = 4;
/** Título: largo recomendado. */
export const SEO_TITLE_MIN = 15;
export const SEO_TITLE_MAX = 60;
/** Meta descripción: largo recomendado. */
export const SEO_DESCRIPTION_MIN = 50;
export const SEO_DESCRIPTION_MAX = 160;

// ---------------------------------------------------------------- ajustes

export type SeoCrawlScope = 'tenant' | 'platform';

export interface SeoCrawlSettings {
  /** Rastreo semanal (apagado por defecto en los tenants, encendido en la plataforma). */
  weeklyEnabled: boolean;
  /** Día de la semana (0 domingo … 6 sábado) y hora (España). */
  weekday: number;
  hour: number;
  /** Páginas como mucho en cada rastreo. */
  maxPages: number;
  /** Pausa entre dos peticiones (milisegundos). */
  pauseMs: number;
  /** Minutos como mucho de un rastreo. */
  maxMinutes: number;
  /** Rutas que no se rastrean (misma sintaxis que las reglas de indexación). */
  excludePaths: string[];
}

export const SEO_CRAWL_DEFAULTS: Record<SeoCrawlScope, SeoCrawlSettings> = {
  tenant: {
    weeklyEnabled: false,
    weekday: 1,
    hour: 3,
    maxPages: 500,
    pauseMs: 1000,
    maxMinutes: 60,
    excludePaths: [],
  },
  platform: {
    weeklyEnabled: true,
    weekday: 1,
    hour: 3,
    maxPages: 2000,
    pauseMs: 1000,
    maxMinutes: 240,
    excludePaths: [],
  },
};

type CrawlNumericKey = 'weekday' | 'hour' | 'maxPages' | 'pauseMs' | 'maxMinutes';

export const SEO_CRAWL_RANGES: Record<
  SeoCrawlScope,
  Record<CrawlNumericKey, { min: number; max: number; label: string }>
> = {
  tenant: {
    weekday: { min: 0, max: 6, label: 'Día de la semana' },
    hour: { min: 0, max: 23, label: 'Hora' },
    maxPages: { min: 10, max: 500, label: 'Páginas como mucho' },
    pauseMs: { min: 500, max: 10_000, label: 'Pausa entre peticiones (ms)' },
    maxMinutes: { min: 5, max: 120, label: 'Minutos como mucho' },
  },
  platform: {
    weekday: { min: 0, max: 6, label: 'Día de la semana' },
    hour: { min: 0, max: 23, label: 'Hora' },
    maxPages: { min: 10, max: 2000, label: 'Páginas como mucho' },
    pauseMs: { min: 500, max: 10_000, label: 'Pausa entre peticiones (ms)' },
    maxMinutes: { min: 5, max: 360, label: 'Minutos como mucho' },
  },
};

export const SEO_WEEKDAY_LABELS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/** Ajustes guardados con los valores por defecto donde falten (y dentro de su rango). */
export function seoCrawlSettingsOf(stored: unknown, scope: SeoCrawlScope): SeoCrawlSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out: SeoCrawlSettings = { ...SEO_CRAWL_DEFAULTS[scope], excludePaths: [] };
  for (const k of Object.keys(SEO_CRAWL_RANGES[scope]) as CrawlNumericKey[]) {
    const v = s[k];
    const r = SEO_CRAWL_RANGES[scope][k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.min(r.max, Math.max(r.min, Math.round(v)));
    }
  }
  if (typeof s.weeklyEnabled === 'boolean') out.weeklyEnabled = s.weeklyEnabled;
  if (Array.isArray(s.excludePaths)) {
    out.excludePaths = [
      ...new Set(
        s.excludePaths
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
          .filter((p) => p.length > 0 && p.length <= 200),
      ),
    ].slice(0, 50);
  }
  return out;
}

export const UpdateSeoCrawlSettingsSchema = z
  .object({
    weeklyEnabled: z.boolean(),
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    maxPages: z.number().int().min(10).max(2000),
    pauseMs: z.number().int().min(500).max(10_000),
    maxMinutes: z.number().int().min(5).max(360),
    excludePaths: z.array(z.string().trim().min(1).max(200)).max(50),
    /** Vuelve a los valores por defecto. */
    reset: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateSeoCrawlSettingsInput = z.infer<typeof UpdateSeoCrawlSettingsSchema>;

/** ¿La URL queda fuera por una ruta excluida? */
export function seoCrawlExcluded(url: string, excludePaths: readonly string[]): boolean {
  return excludePaths.some((p) => seoIndexRuleMatches(p, url));
}

/**
 * ¿Toca el rastreo semanal? El día y la hora de España coinciden con los
 * ajustes y no hay otro rastreo en los últimos 6 días.
 */
export function seoCrawlDue(input: {
  settings: SeoCrawlSettings;
  /** Día de la semana y hora de ahora en España. */
  weekday: number;
  hour: number;
  lastStartedAt: string | null;
  now: Date;
}): boolean {
  if (!input.settings.weeklyEnabled) return false;
  if (input.weekday !== input.settings.weekday || input.hour !== input.settings.hour) return false;
  if (!input.lastStartedAt) return true;
  return input.now.getTime() - Date.parse(input.lastStartedAt) >= 6 * 86_400_000;
}

// ------------------------------------------------------------- alcance

/**
 * Lo que se rastrea de un dominio: el host (con y sin `www.`) y, si la
 * propiedad de Search Console es de prefijo con ruta («https://x.es/s/negocio/»),
 * solo lo que cuelga de esa ruta.
 */
export interface SeoCrawlSite {
  /** URL de la portada (por donde empieza). */
  startUrl: string;
  /** Host sin `www.`. */
  host: string;
  scheme: 'http' | 'https';
  /** Ruta que tiene que tener una URL para entrar (`/` = todo el host). */
  pathPrefix: string;
}

/** El sitio que se rastrea a partir de la propiedad de Search Console del dominio principal. */
export function seoCrawlSiteOf(gscProperty: string, domain: string): SeoCrawlSite {
  const p = gscProperty.trim();
  if (/^https?:\/\//i.test(p)) {
    const scheme = /^http:\/\//i.test(p) ? 'http' : 'https';
    const m = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(p);
    const rawHost = (m?.[1] ?? domain).toLowerCase();
    const prefix = (m?.[2] ?? '/').replace(/\/+$/, '') || '/';
    const path = prefix === '/' ? '/' : `${prefix}/`;
    return {
      startUrl: `${scheme}://${rawHost}${path}`,
      host: splitSeoUrl(`//${rawHost}`).host,
      scheme,
      pathPrefix: path,
    };
  }
  const host = domain.toLowerCase().replace(/^www\./, '');
  return { startUrl: `https://${host}/`, host, scheme: 'https', pathPrefix: '/' };
}

/** ¿La URL es del sitio que se rastrea (mismo host, con o sin `www.`, y bajo su ruta)? */
export function seoCrawlInSite(url: string, site: SeoCrawlSite): boolean {
  if (!/^https?:\/\//i.test(url.trim())) return false;
  const { host, path } = splitSeoUrl(url);
  if (host !== site.host) return false;
  if (site.pathPrefix === '/') return true;
  const base = site.pathPrefix.replace(/\/$/, '');
  return path === base || path.startsWith(`${base}/`);
}

// ------------------------------------------------------------- robots.txt

export interface SeoRobotsRule {
  allow: boolean;
  pattern: string;
}
export interface SeoRobotsGroup {
  agents: string[];
  rules: SeoRobotsRule[];
}
export interface SeoRobotsTxt {
  groups: SeoRobotsGroup[];
  sitemaps: string[];
}

/** Lee un robots.txt (líneas `User-agent`, `Allow`, `Disallow` y `Sitemap`). */
export function parseSeoRobotsTxt(text: string): SeoRobotsTxt {
  const groups: SeoRobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: SeoRobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // Un «Disallow:» vacío no bloquea nada.
      if (!value) continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return { groups, sitemaps };
}

/** Reglas que aplican a un rastreador: las del grupo más específico (o las de `*`). */
export function seoRobotsRulesFor(robots: SeoRobotsTxt, token: string): SeoRobotsRule[] {
  const t = token.toLowerCase();
  let best = '';
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a !== '*' && t.startsWith(a) && a.length > best.length) best = a;
    }
  }
  const agent = best || '*';
  return robots.groups.filter((g) => g.agents.includes(agent)).flatMap((g) => g.rules);
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    `^${body
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}${anchored ? '$' : ''}`,
  );
  return re.test(path);
}

/**
 * ¿Deja robots.txt pedir esta URL? Gana la regla más larga que casa y, a
 * igual largo, la que permite (como hace Google). Sin robots.txt, todo vale.
 */
export function seoRobotsAllowed(
  robots: SeoRobotsTxt | null,
  token: string,
  url: string,
): { allowed: boolean; rule: string | null } {
  if (!robots) return { allowed: true, rule: null };
  const s = url.trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^#]*)/i.exec(s);
  let path = m ? m[1] || '/' : s.replace(/#.*$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path === '/robots.txt') return { allowed: true, rule: null };
  let winner: SeoRobotsRule | null = null;
  for (const r of seoRobotsRulesFor(robots, token)) {
    if (!robotsPatternMatches(r.pattern, path)) continue;
    if (
      !winner ||
      r.pattern.length > winner.pattern.length ||
      (r.pattern.length === winner.pattern.length && r.allow && !winner.allow)
    ) {
      winner = r;
    }
  }
  if (!winner) return { allowed: true, rule: null };
  return {
    allowed: winner.allow,
    rule: `${winner.allow ? 'Allow' : 'Disallow'}: ${winner.pattern}`,
  };
}

/** Las URL `<loc>` de un mapa del sitio y si es un índice de mapas. */
export function parseSeoSitemap(xml: string): { index: boolean; urls: string[] } {
  const index = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const v = decodeXmlEntities(m[1]!.trim());
    if (/^https?:\/\//i.test(v)) urls.push(v);
  }
  return { index, urls };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

// ------------------------------------------------------------- incidencias

export const SEO_CRAWL_ISSUE_TYPES = [
  'http_error',
  'fetch_failed',
  'slow_response',
  'redirect_chain',
  'broken_link',
  'redirected_link',
  'robots_blocked',
  'title_missing',
  'title_duplicate',
  'title_too_long',
  'title_too_short',
  'description_missing',
  'description_duplicate',
  'description_too_long',
  'description_too_short',
  'h1_missing',
  'h1_multiple',
  'h1_duplicate',
  'canonical_missing',
  'canonical_other',
  'canonical_variant',
  'canonical_redirect',
  'canonical_error',
  'noindex',
  'nofollow',
  'hreflang_invalid',
  'structured_data_invalid',
  'images_without_alt',
  'orphan_page',
  'deep_page',
  'not_reached',
  'sitemap_missing',
  'sitemap_unreachable',
  'sitemap_error',
  'sitemap_redirect',
  'sitemap_noindex',
  'sitemap_blocked',
] as const;
export type SeoCrawlIssueType = (typeof SEO_CRAWL_ISSUE_TYPES)[number];
export const SeoCrawlIssueTypeEnum = z.enum(SEO_CRAWL_ISSUE_TYPES);

export const SEO_CRAWL_ISSUE_GROUPS = [
  'response',
  'content',
  'indexing',
  'links',
  'sitemap',
  'other',
] as const;
export type SeoCrawlIssueGroup = (typeof SEO_CRAWL_ISSUE_GROUPS)[number];
export const SEO_CRAWL_ISSUE_GROUP_LABELS: Record<SeoCrawlIssueGroup, string> = {
  response: 'Respuesta de la página',
  content: 'Título, descripción y encabezados',
  indexing: 'Canónica e indexación',
  links: 'Enlaces internos',
  sitemap: 'Mapa del sitio',
  other: 'Otras',
};

export interface SeoCrawlIssueInfo {
  label: string;
  group: SeoCrawlIssueGroup;
  /** Gravedad por defecto (la portada y las URL objetivo pueden subirla). */
  severity: SeoSeverity;
  /** Qué pasa, en palabras. */
  what: string;
  /** Qué hacer. */
  how: string;
}

export const SEO_CRAWL_ISSUES: Record<SeoCrawlIssueType, SeoCrawlIssueInfo> = {
  http_error: {
    label: 'Página que da error',
    group: 'response',
    severity: 'high',
    what: 'La página responde con un error (404, 500…): quien llega a ella no ve nada y Google acabará quitándola.',
    how: 'Si la página existe, arregla el error; si ya no existe, redirige su dirección (301) a la más parecida y quita los enlaces que llevan a ella.',
  },
  fetch_failed: {
    label: 'No se pudo leer',
    group: 'response',
    severity: 'medium',
    what: 'El rastreador no pudo leer la página (tardó demasiado, la conexión falló o era demasiado grande).',
    how: 'Ábrela en el navegador: si va lenta o falla, revisa el servidor; si es un fichero enorme, no lo enlaces como página.',
  },
  slow_response: {
    label: 'Respuesta lenta',
    group: 'response',
    severity: 'low',
    what: 'El servidor tarda más de 3 segundos en responder esta página.',
    how: 'Mira «Velocidad» (PageSpeed) y revisa el servidor, la caché o lo que hace la página al cargar.',
  },
  redirect_chain: {
    label: 'Cadena de redirecciones',
    group: 'response',
    severity: 'low',
    what: 'Para llegar a la página hay que pasar por varias redirecciones seguidas.',
    how: 'Haz que la primera dirección redirija directamente a la última y actualiza los enlaces para que apunten a la definitiva.',
  },
  broken_link: {
    label: 'Enlaces internos rotos',
    group: 'links',
    severity: 'high',
    what: 'Hay enlaces de tu web que llevan a una página que da error.',
    how: 'Cambia esos enlaces por la dirección correcta o redirige la página rota a la buena.',
  },
  redirected_link: {
    label: 'Enlaces a una página que redirige',
    group: 'links',
    severity: 'low',
    what: 'Hay enlaces de tu web que apuntan a una dirección que redirige a otra.',
    how: 'Cambia los enlaces para que apunten directamente a la dirección final: ahorras un salto a Google y a las visitas.',
  },
  robots_blocked: {
    label: 'Bloqueada por robots.txt',
    group: 'indexing',
    severity: 'low',
    what: 'robots.txt no deja leer esta página y tu web la enlaza o la pone en el mapa del sitio.',
    how: 'Si es una página que quieres en Google, quita la regla de robots.txt; si no, deja de enlazarla y sácala del mapa del sitio.',
  },
  title_missing: {
    label: 'Sin título',
    group: 'content',
    severity: 'high',
    what: 'La página no tiene etiqueta <title>: Google inventará uno y casi nunca es el mejor.',
    how: 'Escribe un título único de 15 a 60 caracteres con la búsqueda principal de la página.',
  },
  title_duplicate: {
    label: 'Título repetido',
    group: 'content',
    severity: 'medium',
    what: 'Varias páginas tienen el mismo título y Google no sabe cuál enseñar para cada búsqueda.',
    how: 'Dale a cada página un título distinto que diga lo que tiene de propio (el servicio, la ciudad, el tamaño…).',
  },
  title_too_long: {
    label: 'Título largo',
    group: 'content',
    severity: 'low',
    what: 'El título pasa de 60 caracteres: Google lo cortará en los resultados.',
    how: 'Acórtalo y deja lo importante al principio.',
  },
  title_too_short: {
    label: 'Título corto',
    group: 'content',
    severity: 'low',
    what: 'El título tiene menos de 15 caracteres: desaprovechas el espacio que da Google.',
    how: 'Amplíalo con la búsqueda principal y una ventaja clara (precio, ubicación…).',
  },
  description_missing: {
    label: 'Sin meta descripción',
    group: 'content',
    severity: 'medium',
    what: 'La página no tiene meta descripción: Google enseñará un trozo de texto cualquiera.',
    how: 'Escribe una descripción de 50 a 160 caracteres que invite a hacer clic.',
  },
  description_duplicate: {
    label: 'Meta descripción repetida',
    group: 'content',
    severity: 'low',
    what: 'Varias páginas tienen la misma meta descripción.',
    how: 'Escribe una descripción distinta para cada página, con lo que tiene de propio.',
  },
  description_too_long: {
    label: 'Meta descripción larga',
    group: 'content',
    severity: 'low',
    what: 'La meta descripción pasa de 160 caracteres: Google la cortará.',
    how: 'Acórtala y deja lo importante al principio.',
  },
  description_too_short: {
    label: 'Meta descripción corta',
    group: 'content',
    severity: 'low',
    what: 'La meta descripción tiene menos de 50 caracteres.',
    how: 'Amplíala: di qué encontrará quien entre y por qué elegirte.',
  },
  h1_missing: {
    label: 'Sin encabezado H1',
    group: 'content',
    severity: 'medium',
    what: 'La página no tiene encabezado principal (H1).',
    how: 'Pon un H1 que diga de qué trata la página (suele parecerse al título).',
  },
  h1_multiple: {
    label: 'Varios H1',
    group: 'content',
    severity: 'low',
    what: 'La página tiene más de un encabezado principal (H1).',
    how: 'Deja un solo H1 y pasa los demás a H2.',
  },
  h1_duplicate: {
    label: 'H1 repetido',
    group: 'content',
    severity: 'low',
    what: 'Varias páginas tienen el mismo encabezado principal.',
    how: 'Haz que el H1 de cada página diga lo que tiene de propio.',
  },
  canonical_missing: {
    label: 'Sin canónica',
    group: 'indexing',
    severity: 'low',
    what: 'La página no declara cuál es su versión buena (etiqueta canónica).',
    how: 'Añade <link rel="canonical"> apuntando a su propia dirección definitiva.',
  },
  canonical_other: {
    label: 'La canónica apunta a otra página',
    group: 'indexing',
    severity: 'medium',
    what: 'La página dice que su versión buena es otra página: Google enseñará esa en su lugar.',
    how: 'Si es a propósito (es una variante), bien; si no, haz que la canónica apunte a la propia página.',
  },
  canonical_variant: {
    label: 'La canónica no coincide con la URL',
    group: 'indexing',
    severity: 'low',
    what: 'La canónica es la misma página, pero escrita de otra forma (http o https, con o sin www, barra final).',
    how: 'Escribe la canónica exactamente como la dirección definitiva de la página.',
  },
  canonical_redirect: {
    label: 'La canónica redirige',
    group: 'indexing',
    severity: 'medium',
    what: 'La canónica apunta a una dirección que redirige a otra.',
    how: 'Pon como canónica la dirección final, la que no redirige.',
  },
  canonical_error: {
    label: 'La canónica da error',
    group: 'indexing',
    severity: 'high',
    what: 'La canónica apunta a una página que da error: Google puede ignorarla o quitar las dos.',
    how: 'Corrige la canónica para que apunte a una página que funcione (normalmente, la propia).',
  },
  noindex: {
    label: 'Con «noindex»',
    group: 'indexing',
    severity: 'medium',
    what: 'La página pide a Google que no la enseñe (meta robots o cabecera X-Robots-Tag).',
    how: 'Si es una página privada, está bien; si quieres que salga en Google, quita el «noindex».',
  },
  nofollow: {
    label: 'Con «nofollow»',
    group: 'indexing',
    severity: 'low',
    what: 'La página pide a Google que no siga sus enlaces.',
    how: 'Quítalo salvo que sea a propósito: impide que Google descubra las páginas a las que enlaza.',
  },
  hreflang_invalid: {
    label: 'Idiomas (hreflang) mal puestos',
    group: 'indexing',
    severity: 'low',
    what: 'Las etiquetas de idioma (hreflang) tienen errores: códigos que no existen, sin la propia página o sin el enlace de vuelta.',
    how: 'Cada versión debe enlazar a todas las demás y a sí misma con códigos correctos (es, en, es-ES, x-default).',
  },
  structured_data_invalid: {
    label: 'Datos estructurados que no se leen',
    group: 'other',
    severity: 'low',
    what: 'La página tiene datos estructurados (JSON-LD) con errores de formato: Google no los puede usar.',
    how: 'Revisa el bloque JSON-LD con la prueba de resultados enriquecidos de Google.',
  },
  images_without_alt: {
    label: 'Imágenes sin texto alternativo',
    group: 'content',
    severity: 'low',
    what: 'Hay imágenes sin texto alternativo (alt): Google no sabe qué enseñan y las personas que usan lector de pantalla tampoco.',
    how: 'Describe cada imagen en su atributo alt (en las decorativas, alt vacío).',
  },
  orphan_page: {
    label: 'Página huérfana',
    group: 'links',
    severity: 'medium',
    what: 'Ninguna página de tu web enlaza a esta, aunque está en el mapa del sitio o tiene impresiones en Google.',
    how: 'Enlázala desde las páginas relacionadas (o desde el menú) para que Google y las visitas la encuentren.',
  },
  deep_page: {
    label: 'Página muy lejos de la portada',
    group: 'links',
    severity: 'low',
    what: 'Hacen falta 4 clics o más desde la portada para llegar a esta página.',
    how: 'Enlázala desde páginas más cercanas a la portada (menú, categorías, páginas con visitas).',
  },
  not_reached: {
    label: 'Con impresiones y sin rastrear',
    group: 'links',
    severity: 'medium',
    what: 'Google enseña esta página, pero el rastreo no llegó a ella (tope de páginas, ruta excluida o sin enlaces).',
    how: 'Comprueba que sigue siendo una página tuya, enlázala desde tu web o sube el tope de páginas del rastreo.',
  },
  sitemap_missing: {
    label: 'Sin mapa del sitio',
    group: 'sitemap',
    severity: 'medium',
    what: 'No se ha encontrado ningún mapa del sitio (ni en robots.txt ni en /sitemap.xml).',
    how: 'Publica un sitemap.xml con tus páginas, añádelo a robots.txt y envíalo en Search Console.',
  },
  sitemap_unreachable: {
    label: 'Mapa del sitio que no se puede leer',
    group: 'sitemap',
    severity: 'high',
    what: 'Un mapa del sitio que se declara no responde o no es un mapa válido.',
    how: 'Comprueba que la dirección del mapa funciona y devuelve el XML del sitemap.',
  },
  sitemap_error: {
    label: 'En el mapa del sitio y da error',
    group: 'sitemap',
    severity: 'high',
    what: 'El mapa del sitio incluye una página que da error.',
    how: 'Quítala del mapa del sitio o arregla la página.',
  },
  sitemap_redirect: {
    label: 'En el mapa del sitio y redirige',
    group: 'sitemap',
    severity: 'medium',
    what: 'El mapa del sitio incluye una dirección que redirige a otra.',
    how: 'Pon en el mapa la dirección final, no la que redirige.',
  },
  sitemap_noindex: {
    label: 'En el mapa del sitio y con «noindex»',
    group: 'sitemap',
    severity: 'high',
    what: 'El mapa del sitio pide a Google que mire una página que a la vez dice «no me indexes».',
    how: 'Decide: si debe salir en Google, quita el «noindex»; si no, sácala del mapa del sitio.',
  },
  sitemap_blocked: {
    label: 'En el mapa del sitio y bloqueada',
    group: 'sitemap',
    severity: 'medium',
    what: 'El mapa del sitio incluye una página que robots.txt no deja leer a Google.',
    how: 'Quita la regla de robots.txt o saca la página del mapa del sitio.',
  },
};

export const SEO_CRAWL_ISSUE_TYPE_LABELS = Object.fromEntries(
  SEO_CRAWL_ISSUE_TYPES.map((t) => [t, SEO_CRAWL_ISSUES[t].label]),
) as Record<SeoCrawlIssueType, string>;

// ---------------------------------------------------------- análisis del sitio

/** Cómo llegó el rastreo a una URL. */
export type SeoCrawlSource = 'home' | 'link' | 'sitemap' | 'gsc' | 'finding' | 'canonical';

/** Lo que se sabe de una URL tras pedirla (o tras no pedirla por robots.txt). */
export interface SeoCrawlPageFacts {
  url: string;
  /** URL normalizada (`normalizeSeoUrl`). */
  key: string;
  source: SeoCrawlSource;
  /** Del sitio rastreado (si no, solo se pide para confirmar un hallazgo). */
  inScope: boolean;
  /** Código de la primera respuesta (3xx si redirige); null si no se pidió o falló. */
  status: number | null;
  /** Código de la última respuesta tras seguir las redirecciones. */
  finalStatus: number | null;
  finalUrl: string | null;
  /** Direcciones por las que pasa tras la primera (la última es la final). */
  redirectChain: string[];
  error: string | null;
  responseMs: number | null;
  isHtml: boolean;
  /** robots.txt no deja pedirla a este rastreador (no se pidió). */
  robotsBlocked: boolean;
  /** robots.txt no deja leerla a Google. */
  googleBlocked: boolean;
  title: string | null;
  description: string | null;
  h1: string[];
  canonical: string | null;
  noindex: boolean;
  nofollow: boolean;
  hreflang: { lang: string; href: string }[];
  jsonLdTypes: string[];
  jsonLdInvalid: number;
  imagesTotal: number;
  imagesWithoutAlt: number;
  /** Enlaces internos (absolutos, sin repetir). */
  links: string[];
  inSitemap: boolean;
  /** Impresiones de Search Console (0 si no tiene). */
  impressions: number;
}

export interface SeoCrawlIssueCandidate {
  type: SeoCrawlIssueType;
  url: string;
  /** Clave de deduplicación: tipo + URL normalizada. */
  key: string;
  severity: SeoSeverity;
  detail: string;
  data: Record<string, unknown>;
}

export interface SeoCrawlAnalysis {
  issues: SeoCrawlIssueCandidate[];
  /** Profundidad de clic desde la portada (null = no se llega por enlaces). */
  depth: Map<string, number | null>;
  /** Páginas que enlazan a cada URL (claves normalizadas). */
  inlinks: Map<string, string[]>;
}

const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-([a-z]{4}|[a-z]{2}|\d{3}))?(-[a-z]{2})?)$/i;

const isOk = (p: SeoCrawlPageFacts) => p.status !== null && p.status >= 200 && p.status < 300;
const isRedirect = (p: SeoCrawlPageFacts) => p.status !== null && p.status >= 300 && p.status < 400;
const isError = (p: SeoCrawlPageFacts) => !!p.error || (p.status !== null && p.status >= 400);
const statusText = (p: SeoCrawlPageFacts) =>
  p.error ? `no responde (${p.error})` : `responde ${p.status ?? '—'}`;
const list = (urls: readonly string[], max = 3) =>
  `${urls.slice(0, max).join(', ')}${urls.length > max ? ` y ${seoFmtInt(urls.length - max)} más` : ''}`;

/** Enlaces del grafo (de páginas del sitio que responden bien) y las redirecciones. */
export function seoCrawlLinkGraph(pages: readonly SeoCrawlPageFacts[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of pages) {
    if (!p.inScope) continue;
    const targets = new Set<string>();
    if (isOk(p) && p.isHtml) {
      for (const l of p.links) {
        const k = normalizeSeoUrl(l);
        if (k !== p.key) targets.add(k);
      }
    }
    // Una redirección lleva a su destino (para la profundidad y las huérfanas).
    if (isRedirect(p) && p.finalUrl) {
      const k = normalizeSeoUrl(p.finalUrl);
      if (k !== p.key) targets.add(k);
    }
    if (targets.size > 0) out.set(p.key, targets);
  }
  return out;
}

/** Profundidad de clic desde la portada (recorrido en anchura sobre los enlaces). */
export function seoCrawlDepths(
  homeKey: string,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  const depth = new Map<string, number>([[homeKey, 0]]);
  const queue = [homeKey];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]!;
    const d = depth.get(k)!;
    for (const t of graph.get(k) ?? []) {
      if (depth.has(t)) continue;
      depth.set(t, d + 1);
      queue.push(t);
    }
  }
  return depth;
}

/**
 * Incidencias de un rastreo completo. Las de cada página (título,
 * descripción, encabezados, canónica, robots, idiomas, datos estructurados,
 * imágenes) y las del sitio entero (repetidos, enlaces rotos o que
 * redirigen, huérfanas, profundidad, mapa del sitio y lo que tiene
 * impresiones y no se alcanzó). La portada y las URL objetivo suben a gravedad
 * alta cuando dan error o tienen «noindex».
 */
export function analyzeSeoCrawl(input: {
  pages: readonly SeoCrawlPageFacts[];
  homeKey: string;
  /** URL objetivo de las palabras seguidas (claves normalizadas). */
  targetKeys?: ReadonlySet<string>;
  sitemapFound: boolean;
  sitemapErrors?: readonly { url: string; error: string }[];
  /** Páginas con impresiones del sitio que el rastreo no pidió. */
  unreached?: readonly { url: string; impressions: number }[];
}): SeoCrawlAnalysis {
  const pages = input.pages;
  const byKey = new Map(pages.map((p) => [p.key, p]));
  const graph = seoCrawlLinkGraph(pages);
  const depthMap = seoCrawlDepths(input.homeKey, graph);
  const inlinks = new Map<string, string[]>();
  for (const [from, targets] of graph) {
    const src = byKey.get(from);
    // Solo cuentan los enlaces de verdad (no la redirección de sí misma).
    if (!src || !isOk(src)) continue;
    for (const t of targets) inlinks.set(t, [...(inlinks.get(t) ?? []), src.url]);
  }
  const targets = input.targetKeys ?? new Set<string>();
  const out: SeoCrawlIssueCandidate[] = [];
  const add = (
    type: SeoCrawlIssueType,
    p: { url: string; key: string },
    detail: string,
    data: Record<string, unknown> = {},
    severity?: SeoSeverity,
  ) =>
    out.push({
      type,
      url: p.url,
      key: `${type}|${p.key}`,
      severity: severity ?? SEO_CRAWL_ISSUES[type].severity,
      detail,
      data,
    });
  const important = (key: string) => key === input.homeKey || targets.has(key);
  const pick = (key: string, normal: SeoSeverity): SeoSeverity =>
    important(key) ? 'high' : normal;

  const indexable = pages.filter(
    (p) => p.inScope && isOk(p) && p.isHtml && !p.noindex && !p.robotsBlocked,
  );

  for (const p of pages) {
    if (!p.inScope) continue;
    if (p.robotsBlocked) continue;
    if (p.error) {
      add(
        'fetch_failed',
        p,
        `No se pudo leer: ${p.error}.`,
        { error: p.error },
        pick(p.key, 'medium'),
      );
      continue;
    }
    if (p.status !== null && p.status >= 400) {
      add('http_error', p, `Responde ${p.status}.`, { status: p.status });
      continue;
    }
    if (isRedirect(p)) {
      if (p.redirectChain.length >= 2) {
        add(
          'redirect_chain',
          p,
          `${seoFmtInt(p.redirectChain.length)} redirecciones seguidas: ${[p.url, ...p.redirectChain].join(' → ')}.`,
          { chain: p.redirectChain },
        );
      }
      continue;
    }
    if (p.responseMs !== null && p.responseMs > SEO_CRAWL_SLOW_MS) {
      add('slow_response', p, `Tardó ${seoFmtInt(p.responseMs)} ms en responder.`, {
        ms: p.responseMs,
      });
    }
    if (!isOk(p) || !p.isHtml) continue;

    // Robots de la página.
    if (p.noindex) {
      if (p.inSitemap) {
        add('sitemap_noindex', p, 'Tiene «noindex» y está en el mapa del sitio.', {}, 'high');
      } else {
        add(
          'noindex',
          p,
          important(p.key)
            ? `Tiene «noindex» y es ${p.key === input.homeKey ? 'la portada' : 'una URL objetivo de tus palabras'}: Google no la enseñará.`
            : 'Tiene «noindex»: Google no la enseñará.',
          {},
          pick(p.key, 'medium'),
        );
      }
    }
    if (p.nofollow) add('nofollow', p, 'Tiene «nofollow»: Google no sigue sus enlaces.');

    // Contenido (solo en las páginas que pueden salir en Google).
    if (!p.noindex) {
      const title = (p.title ?? '').trim();
      if (!title) add('title_missing', p, 'No tiene título.');
      else if (title.length > SEO_TITLE_MAX)
        add('title_too_long', p, `El título tiene ${title.length} caracteres: «${title}».`, {
          length: title.length,
        });
      else if (title.length < SEO_TITLE_MIN)
        add('title_too_short', p, `El título tiene ${title.length} caracteres: «${title}».`, {
          length: title.length,
        });
      const desc = (p.description ?? '').trim();
      if (!desc) add('description_missing', p, 'No tiene meta descripción.');
      else if (desc.length > SEO_DESCRIPTION_MAX)
        add('description_too_long', p, `La meta descripción tiene ${desc.length} caracteres.`, {
          length: desc.length,
        });
      else if (desc.length < SEO_DESCRIPTION_MIN)
        add('description_too_short', p, `La meta descripción tiene ${desc.length} caracteres.`, {
          length: desc.length,
        });
      if (p.h1.length === 0) add('h1_missing', p, 'No tiene H1.');
      else if (p.h1.length > 1)
        add('h1_multiple', p, `Tiene ${p.h1.length} H1: ${p.h1.map((h) => `«${h}»`).join(', ')}.`, {
          h1: p.h1,
        });
    }

    // Canónica.
    if (!p.canonical) {
      if (!p.noindex) add('canonical_missing', p, 'No declara canónica.');
    } else {
      const ck = normalizeSeoUrl(p.canonical);
      const target = byKey.get(ck);
      if (ck !== p.key) {
        add('canonical_other', p, `Declara como canónica otra página: ${p.canonical}.`, {
          canonical: p.canonical,
        });
      } else if (p.canonical.trim() !== (p.finalUrl ?? p.url) && p.canonical.trim() !== p.url) {
        add(
          'canonical_variant',
          p,
          `La canónica es ${p.canonical} y la página se rastreó como ${p.url}.`,
          { canonical: p.canonical },
        );
      }
      if (target && target.key !== p.key) {
        if (isError(target)) {
          add('canonical_error', p, `La canónica ${p.canonical} ${statusText(target)}.`, {
            canonical: p.canonical,
            status: target.status,
          });
        } else if (isRedirect(target)) {
          add(
            'canonical_redirect',
            p,
            `La canónica ${p.canonical} redirige a ${target.finalUrl ?? '—'}.`,
            { canonical: p.canonical, finalUrl: target.finalUrl },
          );
        }
      }
    }

    // Idiomas.
    if (p.hreflang.length > 0) {
      const problems: string[] = [];
      const bad = p.hreflang.filter((h) => !HREFLANG_RE.test(h.lang));
      if (bad.length) problems.push(`códigos que no existen: ${bad.map((h) => h.lang).join(', ')}`);
      if (!p.hreflang.some((h) => normalizeSeoUrl(h.href) === p.key))
        problems.push('no se incluye a sí misma');
      const noReturn = p.hreflang.filter((h) => {
        const other = byKey.get(normalizeSeoUrl(h.href));
        if (!other || other.key === p.key || !isOk(other) || !other.isHtml) return false;
        return !other.hreflang.some((x) => normalizeSeoUrl(x.href) === p.key);
      });
      if (noReturn.length)
        problems.push(`sin enlace de vuelta desde ${list(noReturn.map((h) => h.href))}`);
      if (problems.length)
        add('hreflang_invalid', p, `Idiomas: ${problems.join('; ')}.`, { problems });
    }
    if (p.jsonLdInvalid > 0) {
      add(
        'structured_data_invalid',
        p,
        `${seoFmtInt(p.jsonLdInvalid)} bloque(s) JSON-LD con errores de formato.`,
        { invalid: p.jsonLdInvalid },
      );
    }
    if (p.imagesWithoutAlt > 0) {
      add(
        'images_without_alt',
        p,
        `${seoFmtInt(p.imagesWithoutAlt)} de ${seoFmtInt(p.imagesTotal)} imágenes sin texto alternativo.`,
        { without: p.imagesWithoutAlt, total: p.imagesTotal },
      );
    }

    // Profundidad y huérfanas.
    const depth = depthMap.get(p.key);
    if (depth !== undefined && depth >= SEO_CRAWL_DEEP_DEPTH) {
      add('deep_page', p, `Está a ${depth} clics de la portada.`, { depth });
    }
    if (
      p.key !== input.homeKey &&
      !p.noindex &&
      (inlinks.get(p.key)?.length ?? 0) === 0 &&
      (p.inSitemap || p.impressions > 0)
    ) {
      const why = [
        p.inSitemap ? 'está en el mapa del sitio' : null,
        p.impressions > 0 ? `tiene ${seoFmtInt(p.impressions)} impresiones en Google` : null,
      ].filter(Boolean);
      add(
        'orphan_page',
        p,
        `Ninguna página la enlaza y ${why.join(' y ')}.`,
        {
          inSitemap: p.inSitemap,
          impressions: p.impressions,
        },
        targets.has(p.key) ? 'high' : 'medium',
      );
    }
  }

  // Repetidos entre páginas indexables.
  const dup = (
    type: 'title_duplicate' | 'description_duplicate' | 'h1_duplicate',
    value: (p: SeoCrawlPageFacts) => string | null,
    what: string,
  ) => {
    const groups = new Map<string, SeoCrawlPageFacts[]>();
    for (const p of indexable) {
      const v = (value(p) ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (!v) continue;
      groups.set(v, [...(groups.get(v) ?? []), p]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const p of g) {
        const others = g.filter((x) => x.key !== p.key).map((x) => x.url);
        add(type, p, `${what} igual que ${list(others)}.`, {
          others: others.slice(0, 20),
          count: g.length,
        });
      }
    }
  };
  dup('title_duplicate', (p) => p.title, 'Mismo título');
  dup('description_duplicate', (p) => p.description, 'Misma meta descripción');
  dup('h1_duplicate', (p) => p.h1[0] ?? null, 'Mismo H1');

  // Enlaces que llevan a páginas con error, que redirigen o que robots.txt bloquea.
  for (const [k, sources] of inlinks) {
    const t = byKey.get(k);
    if (!t) continue;
    const data = { sources: sources.slice(0, 20), count: sources.length };
    const from = `desde ${list(sources)}`;
    if (t.robotsBlocked) {
      add(
        'robots_blocked',
        t,
        `robots.txt no la deja leer y la enlazan ${seoFmtInt(sources.length)} página(s) ${from}.`,
        data,
      );
    } else if (isError(t)) {
      add(
        'broken_link',
        t,
        `${seoFmtInt(sources.length)} enlace(s) internos llevan a esta página, que ${statusText(t)}: ${from}.`,
        data,
        'high',
      );
    } else if (isRedirect(t)) {
      add(
        'redirected_link',
        t,
        `${seoFmtInt(sources.length)} enlace(s) internos apuntan a esta dirección, que redirige a ${t.finalUrl ?? '—'}: ${from}.`,
        { ...data, finalUrl: t.finalUrl },
      );
    }
  }

  // Mapa del sitio.
  if (!input.sitemapFound) {
    const home = byKey.get(input.homeKey);
    add(
      'sitemap_missing',
      { url: home?.url ?? input.homeKey, key: input.homeKey },
      'No hay mapa del sitio en robots.txt ni en /sitemap.xml.',
    );
  }
  for (const e of input.sitemapErrors ?? []) {
    add(
      'sitemap_unreachable',
      { url: e.url, key: normalizeSeoUrl(e.url) },
      `El mapa del sitio ${e.url}: ${e.error}.`,
      {
        error: e.error,
      },
    );
  }
  for (const p of pages) {
    if (!p.inSitemap || !p.inScope) continue;
    if (p.robotsBlocked) {
      if (p.googleBlocked)
        add('sitemap_blocked', p, 'robots.txt no deja leerla y está en el mapa del sitio.');
      continue;
    }
    if (isError(p))
      add('sitemap_error', p, `Está en el mapa del sitio y ${statusText(p)}.`, {
        status: p.status,
      });
    else if (isRedirect(p))
      add('sitemap_redirect', p, `Está en el mapa del sitio y redirige a ${p.finalUrl ?? '—'}.`, {
        finalUrl: p.finalUrl,
      });
    else if (p.googleBlocked && !p.robotsBlocked)
      add('sitemap_blocked', p, 'robots.txt no deja leerla a Google y está en el mapa del sitio.');
  }

  // Con impresiones y sin rastrear.
  for (const u of input.unreached ?? []) {
    add(
      'not_reached',
      { url: u.url, key: normalizeSeoUrl(u.url) },
      `Tiene ${seoFmtInt(u.impressions)} impresiones en Google y el rastreo no llegó a ella.`,
      { impressions: u.impressions },
    );
  }

  // Una incidencia por tipo y URL (la primera que sale).
  const seen = new Set<string>();
  const issues = out.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  const depth = new Map<string, number | null>();
  for (const p of pages) depth.set(p.key, depthMap.get(p.key) ?? null);
  return { issues, depth, inlinks };
}

// -------------------------------------------------- ciclo de vida y comparación

/** Comparación de un rastreo con el anterior: nuevas, resueltas y las que siguen. */
export interface SeoCrawlComparison {
  newIssues: number;
  resolvedIssues: number;
  continuingIssues: number;
}

export function compareSeoCrawlIssues(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
): SeoCrawlComparison {
  let continuing = 0;
  for (const k of current) if (previous.has(k)) continuing++;
  let resolved = 0;
  for (const k of previous) if (!current.has(k)) resolved++;
  return {
    newIssues: current.size - continuing,
    resolvedIssues: resolved,
    continuingIssues: continuing,
  };
}

// ---------------------------------------------- integración con la indexación

/** Lo que vio el rastreador de una URL (su último rastreo). */
export interface SeoCrawlUrlFacts {
  url: string;
  crawledAt: string;
  status: number | null;
  finalStatus: number | null;
  finalUrl: string | null;
  error: string | null;
  noindex: boolean;
  robotsBlocked: boolean;
  googleBlocked: boolean;
  canonical: string | null;
  inSitemap: boolean;
  inlinks: number;
}

/** Lo que confirma el rastreo de un hallazgo de indexación (en la ficha). */
export interface SeoIndexCrawlEvidenceDto extends SeoCrawlUrlFacts {
  /** true = el rastreo confirma el problema; false = ya está resuelto en la web. */
  confirmed: boolean;
  text: string;
}

/**
 * Qué confirma el rastreador de un hallazgo de indexación: una página
 * privada que sigue sin «noindex» y sin bloqueo, una variante sin canónica a
 * la buena, o un dominio que debería redirigir y responde 200.
 */
export function seoIndexCrawlConfirmation(
  category: SeoIndexCategory,
  f: SeoCrawlUrlFacts,
): { confirmed: boolean; text: string } {
  const day = f.crawledAt.slice(0, 10).split('-').reverse().join('/');
  const tail = ` (rastreo del ${day})`;
  if (f.error)
    return { confirmed: false, text: `El rastreador no pudo leerla: ${f.error}${tail}.` };
  if (f.robotsBlocked && f.status === null) {
    return {
      confirmed: category !== 'redirect_domain',
      text: `robots.txt no deja leerla, así que el rastreador no la ha pedido${tail}. Ojo: si Google tampoco puede leerla, no verá un «noindex» y puede seguir enseñándola sin contenido.`,
    };
  }
  const status = f.status ?? 0;
  if (status >= 400)
    return {
      confirmed: false,
      text: `Ya no existe: responde ${status}${tail}. Google la irá quitando sola.`,
    };
  if (status >= 300 && status < 400) {
    return {
      confirmed: false,
      text: `Ya redirige a ${f.finalUrl ?? '—'} (${status})${tail}${category === 'redirect_domain' ? ': correcto.' : '.'}`,
    };
  }
  switch (category) {
    case 'redirect_domain':
      return {
        confirmed: true,
        text: `Confirmado por el rastreador: responde ${status} en vez de redirigir al dominio principal${tail}. Falta la redirección 301.`,
      };
    case 'params':
    case 'duplicate': {
      const ck = f.canonical ? normalizeSeoUrl(f.canonical) : null;
      if (ck && ck !== normalizeSeoUrl(f.url)) {
        return {
          confirmed: false,
          text: `Declara como canónica ${f.canonical}${tail}: Google debería quedarse con esa versión.`,
        };
      }
      return {
        confirmed: true,
        text: f.canonical
          ? `Confirmado por el rastreador: su canónica apunta a sí misma${tail}. Falta la canónica (o la redirección) a la versión buena.`
          : `Confirmado por el rastreador: no declara canónica${tail}. Falta la canónica (o la redirección) a la versión buena.`,
      };
    }
    case 'canonical_mismatch':
    case 'not_indexed': {
      const bits = [
        f.noindex ? 'tiene «noindex»' : 'no tiene «noindex»',
        f.googleBlocked ? 'robots.txt la bloquea para Google' : 'robots.txt no la bloquea',
        f.canonical ? `su canónica es ${f.canonical}` : 'no declara canónica',
        `${seoFmtInt(f.inlinks)} enlace(s) internos le llegan`,
      ];
      return {
        confirmed: f.noindex || f.googleBlocked,
        text: `El rastreador ve que responde ${status}, ${bits.join(', ')}${tail}.`,
      };
    }
    default: {
      if (f.noindex) {
        return {
          confirmed: false,
          text: `Ya tiene «noindex»${tail}: Google la quitará cuando vuelva a pasar por ella.`,
        };
      }
      if (f.googleBlocked) {
        return {
          confirmed: true,
          text: `robots.txt la bloquea para Google, pero no tiene «noindex»${tail}: así Google no puede ver que no debe indexarla. Pon «noindex» y quita el bloqueo hasta que desaparezca.`,
        };
      }
      return {
        confirmed: true,
        text: `Confirmado por el rastreador: responde ${status}, no tiene «noindex» y robots.txt no la bloquea${tail}, así que Google puede seguir indexándola.`,
      };
    }
  }
}

// ---------------------------------------------------- enlazado interno

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'en',
  'y',
  'a',
  'para',
  'por',
  'con',
  'un',
  'una',
  'que',
  'mi',
  'tu',
  'al',
]);

/** Palabras con sentido de una búsqueda (sin artículos ni preposiciones). */
export function seoQueryTokens(q: string): string[] {
  return [
    ...new Set(
      normalizeSeoKeyword(q)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9ñ]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ];
}

/**
 * ¿Es una búsqueda relacionada con la palabra? Comparte con ella todas sus
 * palabras con sentido o, si tiene más de dos, al menos dos.
 */
export function seoRelatedQuery(keyword: string, query: string): boolean {
  const k = seoQueryTokens(keyword);
  if (k.length === 0) return false;
  const q = new Set(seoQueryTokens(query));
  const shared = k.filter((t) => q.has(t)).length;
  return shared >= Math.min(2, k.length);
}

/** Enlazado interno de una URL objetivo (último rastreo). */
export interface SeoCrawlInternalLinkDto {
  url: string;
  urlKey: string;
  keywords: { keyword: string; priority: number }[];
  /** null = el rastreo no llegó a ella. */
  crawled: boolean;
  status: number | null;
  inlinks: number;
  /** Páginas que la enlazan (las 20 primeras). */
  sources: string[];
  depth: number | null;
  /** Por debajo del mínimo (umbral `internalLinksMin` de las oportunidades). */
  few: boolean;
  /** Páginas desde las que conviene enlazarla (impresiones por búsquedas relacionadas). */
  suggestions: { url: string; impressions: number; query: string }[];
}

export interface SeoCrawlInternalLinksDto {
  crawlId: string | null;
  crawledAt: string | null;
  min: number;
  items: SeoCrawlInternalLinkDto[];
}

// ------------------------------------------------------------- alertas

/**
 * Alertas del rastreo: páginas que dan error nuevas en el último rastreo y la
 * portada o una URL objetivo con «noindex», bloqueada o que no responde
 * (gravedad alta).
 */
export function seoCrawlAlerts(input: {
  crawlId: string;
  finishedAt: string;
  /** Errores que aparecen en este rastreo (no estaban en el anterior). */
  newErrors: readonly { url: string; status: number | null; error: string | null }[];
  critical: readonly {
    url: string;
    urlKey: string;
    home: boolean;
    keywords: string[];
    problem: 'error' | 'noindex' | 'blocked';
    status: number | null;
  }[];
}): SeoAlertCandidate[] {
  const out: SeoAlertCandidate[] = [];
  const day = input.finishedAt.slice(0, 10).split('-').reverse().join('/');
  if (input.newErrors.length > 0) {
    const n = input.newErrors.length;
    out.push({
      type: 'crawl_errors',
      key: `crawl_errors|${input.crawlId}`,
      severity: n >= 5 ? 'high' : 'medium',
      title:
        n === 1
          ? `Una página nueva da error: ${input.newErrors[0]!.url}`
          : `${seoFmtInt(n)} páginas nuevas dan error`,
      message: `En el rastreo del ${day}: ${list(
        input.newErrors.map((e) => `${e.url} (${e.error ?? e.status ?? '—'})`),
      )}. Mira «Técnico» → «Rastreo».`,
      data: { crawlId: input.crawlId, urls: input.newErrors.slice(0, 20).map((e) => e.url) },
    });
  }
  for (const c of input.critical) {
    const who = c.home
      ? 'La portada'
      : `La URL objetivo de ${c.keywords
          .slice(0, 3)
          .map((k) => `«${k}»`)
          .join(', ')}`;
    const what =
      c.problem === 'noindex'
        ? 'tiene «noindex»: Google no la enseñará'
        : c.problem === 'blocked'
          ? 'está bloqueada por robots.txt para Google'
          : `no responde bien (${c.status ?? 'sin respuesta'})`;
    out.push({
      type: 'crawl_critical',
      key: `crawl_critical|${c.urlKey}`,
      severity: 'high',
      title: `${who} ${c.problem === 'noindex' ? 'tiene «noindex»' : c.problem === 'blocked' ? 'está bloqueada' : 'no responde'}: ${c.url}`,
      message: `${who} ${what} (rastreo del ${day}). Arréglalo cuanto antes.`,
      data: { url: c.url, problem: c.problem, status: c.status },
    });
  }
  return out;
}

// ------------------------------------------------------------------ DTOs

export type SeoCrawlStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export const SEO_CRAWL_STATUS_LABELS: Record<SeoCrawlStatus, string> = {
  queued: 'En cola',
  running: 'Rastreando',
  done: 'Terminado',
  failed: 'Con error',
  cancelled: 'Cancelado',
};
export type SeoCrawlTrigger = 'manual' | 'scheduled';
/** Por qué se paró antes de acabar (null = recorrió todo). */
export type SeoCrawlStopReason = 'max_pages' | 'max_time' | null;

export interface SeoCrawlRobotsDto {
  /** robots.txt encontrado. */
  found: boolean;
  /** Reglas que aplican a este rastreador. */
  rules: string[];
  /** Mapas del sitio que declara. */
  sitemaps: string[];
  /** URL que no se pidieron porque robots.txt no deja (las 20 primeras). */
  blocked: string[];
  blockedCount: number;
}

export interface SeoCrawlDto {
  id: string;
  status: SeoCrawlStatus;
  trigger: SeoCrawlTrigger;
  startUrl: string;
  pagesCrawled: number;
  pagesFound: number;
  errors: number;
  durationMs: number | null;
  stopReason: SeoCrawlStopReason;
  error: string | null;
  summary:
    | ({
        bySeverity: Record<SeoSeverity, number>;
        byType: Partial<Record<SeoCrawlIssueType, number>>;
      } & SeoCrawlComparison)
    | null;
  robots: SeoCrawlRobotsDto | null;
  sitemaps: { urls: string[]; pages: number; errors: { url: string; error: string }[] } | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SeoCrawlOverviewDto {
  settings: SeoCrawlSettings;
  /** Rastreo en cola o en curso. */
  live: SeoCrawlDto | null;
  /** Último rastreo terminado. */
  last: SeoCrawlDto | null;
  history: SeoCrawlDto[];
  /** Incidencias abiertas (pendientes) por gravedad y tipo. */
  open: {
    bySeverity: Record<SeoSeverity, number>;
    byType: Partial<Record<SeoCrawlIssueType, number>>;
  };
  userAgent: string;
}

export interface SeoCrawlStartResultDto {
  crawl: SeoCrawlDto;
  /** Ya había un rastreo vivo: se devuelve ese. */
  alreadyRunning: boolean;
}

export interface SeoCrawlIssueDto {
  id: string;
  type: SeoCrawlIssueType;
  group: SeoCrawlIssueGroup;
  label: string;
  severity: SeoSeverity;
  url: string;
  detail: string;
  what: string;
  how: string;
  data: Record<string, unknown>;
  status: SeoDiagnosticStatus;
  notes: string | null;
  /** Sigue en el último rastreo. */
  active: boolean;
  /** Apareció (o volvió) en el último rastreo. */
  isNew: boolean;
  returnedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface SeoCrawlIssueListDto {
  crawlId: string | null;
  total: number;
  items: SeoCrawlIssueDto[];
}

export const SEO_CRAWL_ISSUE_LIST_MAX = 500;
export const SEO_CRAWL_PAGE_LIST_MAX = 500;

export interface SeoCrawlPageDto {
  id: string;
  url: string;
  status: number | null;
  finalUrl: string | null;
  responseMs: number | null;
  depth: number | null;
  inlinks: number;
  outlinks: number;
  title: string | null;
  noindex: boolean;
  robotsBlocked: boolean;
  inSitemap: boolean;
  impressions: number;
  source: SeoCrawlSource;
  issues: number;
  error: string | null;
}

export interface SeoCrawlPageListDto {
  crawlId: string | null;
  total: number;
  items: SeoCrawlPageDto[];
}

export interface SeoCrawlPageDetailDto extends SeoCrawlPageDto {
  crawledAt: string;
  contentType: string | null;
  redirectChain: string[];
  description: string | null;
  h1: string[];
  canonical: string | null;
  nofollow: boolean;
  googleBlocked: boolean;
  robotsRule: string | null;
  hreflang: { lang: string; href: string }[];
  jsonLdTypes: string[];
  imagesTotal: number;
  imagesWithoutAlt: number;
  /** Páginas que la enlazan. */
  linksIn: string[];
  /** Enlaces internos que salen de ella. */
  linksOut: string[];
  issuesList: SeoCrawlIssueDto[];
  /** Lo que dice Google de ella (última inspección), si la hay. */
  inspection: SeoUrlIndexStatusDto | null;
}

/** Comprueba la URL pedida en la ficha (absoluta o ruta del sitio). */
export const SeoCrawlPageQuerySchema = z.object({ url: z.string().trim().min(1).max(2000) });
