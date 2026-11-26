import { z } from 'zod';

import { ImportFormatEnum } from '../imports/schemas';
import { ROBOTS_PRIVATE_PATHS, WEB_NOINDEX_PREFIXES, matchesPathPrefix } from '../web/noindex';
import { isBrandQuery } from '../web/search-console';

import { seoFmtInt, seoResolveIntent, type SeoIntentSource } from './opportunities';
import {
  normalizeSeoKeyword,
  SeoKeywordIntentEnum,
  type SeoDataOriginDto,
  type SeoKeywordIntent,
  type SeoKeywordSource,
  type SeoProviderKey,
} from './sistrix';

import type { SeoUrlIndexStatusDto } from './inspection';

/**
 * SEO Avanzado, PR 5: diagnóstico (§18.2–§18.5, §18.7, §19.2 y §19.5).
 * Palabras seguidas (alta desde Search Console y CSV, evolución, URL objetivo
 * frente a la que enseña Google), canibalización y páginas que no deberían
 * estar en Google. Todo lo de este fichero es puro: el API suma con SQL y
 * aquí se decide.
 */

// ------------------------------------------------------------------- URL

/** Parámetros de seguimiento: no cambian la página, se quitan al comparar. */
const TRACKING_PARAM_RE =
  /^(utm_.*|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|dclid|igshid|ttclid|srsltid)$/i;

export const isSeoTrackingParam = (name: string) => TRACKING_PARAM_RE.test(name);

/** Partes de una URL (sin depender del `URL` global, que shared no tipa). */
export function splitSeoUrl(raw: string): {
  host: string;
  path: string;
  params: [string, string][];
} {
  const s = raw.trim().replace(/#.*$/, '');
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)(.*)$/i.exec(s);
  const host = (m ? (m[1] ?? '') : '')
    .toLowerCase()
    .replace(/^[^@]*@/, '')
    .replace(/:(80|443)$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  const rest = m ? (m[2] ?? '') : s;
  const q = rest.indexOf('?');
  let path = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? rest.slice(q + 1) : '';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  const params = query
    .split('&')
    .filter((kv) => kv.length > 0)
    .map((kv): [string, string] => {
      const i = kv.indexOf('=');
      return i >= 0 ? [kv.slice(0, i), kv.slice(i + 1)] : [kv, ''];
    });
  return { host, path, params };
}

/**
 * Clave de una URL para compararla con otra: sin protocolo ni `www.`, sin
 * barra final, en minúsculas y sin parámetros de seguimiento (los demás,
 * ordenados). `http://www.ejemplo.es/Precios/?utm_source=x` y
 * `https://ejemplo.es/precios` son la misma página.
 */
export function normalizeSeoUrl(raw: string): string {
  const { host, path, params } = splitSeoUrl(raw);
  const kept = params
    .filter(([k]) => !isSeoTrackingParam(k))
    .map(([k, v]) => [k.toLowerCase(), v.toLowerCase()] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const query = kept.length
    ? `?${kept.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&')}`
    : '';
  return `${host}${path.toLowerCase()}${query}`;
}

export const sameSeoUrl = (a: string, b: string) => normalizeSeoUrl(a) === normalizeSeoUrl(b);

/** ¿Es la portada (ruta `/`, sin parámetros que cuenten)? */
export function isSeoHomeUrl(raw: string): boolean {
  const { path, params } = splitSeoUrl(raw);
  return path === '/' && params.every(([k]) => isSeoTrackingParam(k));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const pctText = (ratio: number) => `${Math.round(ratio * 100)} %`;
const posText = (n: number | null) => (n === null ? '—' : String(round1(n)).replace('.', ','));

/** Métricas de una página en un periodo (posición media ya calculada). */
export interface SeoPageMetric {
  page: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

/** Una página tras juntar sus variantes (mismas impresiones, posición ponderada). */
export interface SeoMergedPage extends SeoPageMetric {
  key: string;
  /** Las direcciones que se han juntado (la de más impresiones, primero). */
  variants: string[];
}

/** Junta las variantes de una misma URL (protocolo, `www`, barra final, seguimiento). */
export function mergeSeoPages(pages: readonly SeoPageMetric[]): SeoMergedPage[] {
  const by = new Map<
    string,
    { list: SeoPageMetric[]; clicks: number; impressions: number; w: number; ps: number }
  >();
  for (const p of pages) {
    const key = normalizeSeoUrl(p.page);
    const g = by.get(key) ?? { list: [], clicks: 0, impressions: 0, w: 0, ps: 0 };
    g.list.push(p);
    g.clicks += p.clicks;
    g.impressions += p.impressions;
    if (p.position !== null) {
      g.w += p.position * p.impressions;
      g.ps += p.position;
    }
    by.set(key, g);
  }
  return [...by.entries()]
    .map(([key, g]) => {
      const list = [...g.list].sort(
        (a, b) =>
          b.impressions - a.impressions || b.clicks - a.clicks || a.page.localeCompare(b.page),
      );
      const withPos = g.list.filter((p) => p.position !== null);
      const position =
        withPos.length === 0
          ? null
          : round1(g.impressions > 0 ? g.w / g.impressions : g.ps / withPos.length);
      return {
        key,
        page: list[0]!.page,
        clicks: g.clicks,
        impressions: g.impressions,
        position,
        variants: list.map((p) => p.page),
      };
    })
    .sort(
      (a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.key.localeCompare(b.key),
    );
}

// ------------------------------------------------------------ URL objetivo

export const SEO_TARGET_STATUSES = ['ok', 'other_page', 'split', 'none', 'no_target'] as const;
export type SeoTargetStatus = (typeof SEO_TARGET_STATUSES)[number];
export const SEO_TARGET_STATUS_LABELS: Record<SeoTargetStatus, string> = {
  ok: 'Coincide',
  other_page: 'Google enseña otra página',
  split: 'Varias páginas se reparten',
  none: 'No aparece en Google',
  no_target: 'Sin URL objetivo',
};
export const SEO_TARGET_STATUS_HELP: Record<SeoTargetStatus, string> = {
  ok: 'La página que más sale en Google es la que quieres.',
  other_page: 'Google enseña sobre todo otra página tuya para esta búsqueda.',
  split: 'Ninguna página se lleva la mayoría de las impresiones: se reparten.',
  none: 'Esta búsqueda no ha tenido impresiones en el periodo.',
  no_target: 'No has dicho qué página debería salir.',
};

/** Una página «gana» si se lleva al menos esta parte de las impresiones. */
export const SEO_TARGET_DOMINANT_SHARE = 0.6;
/** Por debajo de esta parte, la URL objetivo apenas sale. */
export const SEO_TARGET_MIN_SHARE = 0.2;

export interface SeoTargetEvaluation {
  status: SeoTargetStatus;
  /** La página que más impresiones se lleva (null si ninguna). */
  topPage: string | null;
  topShare: number | null;
  targetShare: number | null;
  /** Propuesta cuando no hay URL objetivo: la que más clics lleva. */
  suggestedUrl: string | null;
}

/**
 * Compara la URL objetivo con lo que enseña Google en el periodo (cruce
 * consulta + página): `ok` si es la que se lleva la mayoría, `other_page` si
 * se lleva otra y la tuya apenas sale, `split` si se reparten, `none` si no
 * hay impresiones y `no_target` sin URL objetivo.
 */
export function seoTargetStatus(input: {
  targetUrl: string | null;
  pages: readonly SeoPageMetric[];
}): SeoTargetEvaluation {
  const merged = mergeSeoPages(input.pages);
  const total = merged.reduce((n, p) => n + p.impressions, 0);
  const top = merged[0] ?? null;
  const byClicks = [...merged].sort(
    (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key),
  );
  const suggestedUrl = byClicks[0] && total > 0 ? byClicks[0].page : null;
  if (total === 0 || !top) {
    return {
      status: input.targetUrl ? 'none' : 'no_target',
      topPage: null,
      topShare: null,
      targetShare: null,
      suggestedUrl: null,
    };
  }
  const topShare = round3(top.impressions / total);
  if (!input.targetUrl) {
    return { status: 'no_target', topPage: top.page, topShare, targetShare: null, suggestedUrl };
  }
  const targetKey = normalizeSeoUrl(input.targetUrl);
  const target = merged.find((p) => p.key === targetKey);
  const targetShare = round3((target?.impressions ?? 0) / total);
  let status: SeoTargetStatus;
  if (top.key === targetKey && topShare >= SEO_TARGET_DOMINANT_SHARE) status = 'ok';
  else if (top.key !== targetKey && targetShare < SEO_TARGET_MIN_SHARE) status = 'other_page';
  else status = 'split';
  return { status, topPage: top.page, topShare, targetShare, suggestedUrl: null };
}

// --------------------------------------------- página ganadora de cada día

export interface SeoDailyPageRow {
  date: string;
  page: string;
  clicks: number;
  impressions: number;
}

/** La página que más impresiones (y luego clics) se lleva cada día, con sus variantes juntas. */
export function seoDailyWinners(
  rows: readonly SeoDailyPageRow[],
): { date: string; page: string }[] {
  const byDate = new Map<
    string,
    Map<string, { page: string; c: number; i: number; best: number }>
  >();
  for (const r of rows) {
    if (r.impressions <= 0 && r.clicks <= 0) continue;
    const key = normalizeSeoUrl(r.page);
    const day = byDate.get(r.date) ?? new Map();
    const g = day.get(key) ?? { page: r.page, c: 0, i: 0, best: -1 };
    g.c += r.clicks;
    g.i += r.impressions;
    if (r.impressions > g.best) {
      g.best = r.impressions;
      g.page = r.page;
    }
    day.set(key, g);
    byDate.set(r.date, day);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, day]) => {
      const best = [...day.entries()].sort(
        (a, b) => b[1].i - a[1].i || b[1].c - a[1].c || a[0].localeCompare(b[0]),
      )[0]!;
      return { date, page: best[1].page };
    });
}

/** Los días en que cambia la página que más sale (comparando URL normalizadas). */
export function seoPageChanges(
  winners: readonly { date: string; page: string }[],
): { date: string; from: string; to: string }[] {
  const out: { date: string; from: string; to: string }[] = [];
  for (let k = 1; k < winners.length; k++) {
    const prev = winners[k - 1]!;
    const cur = winners[k]!;
    if (!sameSeoUrl(prev.page, cur.page))
      out.push({ date: cur.date, from: prev.page, to: cur.page });
  }
  return out;
}

// ----------------------------------------------------------- canibalización

export const SEO_DEFAULT_CANNIBALIZATION_THRESHOLDS = {
  /** Días que se analizan (28 o 90). */
  periodDays: 28,
  /** Impresiones mínimas de la búsqueda en el periodo. */
  minImpressions: 50,
  /** Impresiones mínimas de cada página para contarla. */
  minPageImpressions: 10,
  /** Parte mínima de las impresiones que tiene que llevarse la segunda página. */
  minSecondShare: 0.1,
  /** Cambios de página ganadora en el periodo para hablar de alternancia. */
  minSwitches: 3,
  /** Portada por debajo de esta parte junto a la URL objetivo = caso esperado (gravedad baja). */
  homeLowShare: 0.25,
} as const;
export type SeoCannibalizationThresholdKey = keyof typeof SEO_DEFAULT_CANNIBALIZATION_THRESHOLDS;
export type SeoCannibalizationThresholds = Record<SeoCannibalizationThresholdKey, number>;

export const SEO_CANNIBALIZATION_THRESHOLD_RANGES: Record<
  SeoCannibalizationThresholdKey,
  { min: number; max: number; integer: boolean; label: string }
> = {
  periodDays: { min: 7, max: 90, integer: true, label: 'Días que se analizan' },
  minImpressions: {
    min: 1,
    max: 100_000,
    integer: true,
    label: 'Impresiones mínimas de la búsqueda',
  },
  minPageImpressions: {
    min: 1,
    max: 100_000,
    integer: true,
    label: 'Impresiones mínimas de cada página',
  },
  minSecondShare: {
    min: 0.01,
    max: 0.5,
    integer: false,
    label: 'Parte mínima de la segunda página',
  },
  minSwitches: {
    min: 2,
    max: 30,
    integer: true,
    label: 'Cambios de página para hablar de alternancia',
  },
  homeLowShare: {
    min: 0.01,
    max: 0.5,
    integer: false,
    label: 'Portada con poca parte junto a la URL objetivo',
  },
};

export const SEO_CANNIBALIZATION_KINDS = ['conflict', 'switch', 'split', 'coexistence'] as const;
export type SeoCannibalizationKind = (typeof SEO_CANNIBALIZATION_KINDS)[number];
export const SEO_CANNIBALIZATION_KIND_LABELS: Record<SeoCannibalizationKind, string> = {
  conflict: 'Probable conflicto',
  switch: 'Cambio de página',
  split: 'Reparto entre páginas',
  coexistence: 'Convivencia',
};

export const SEO_SEVERITIES = ['high', 'medium', 'low'] as const;
export type SeoSeverity = (typeof SEO_SEVERITIES)[number];
export const SEO_SEVERITY_LABELS: Record<SeoSeverity, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

/** Las acciones que se pueden sugerir ante una canibalización. */
export const SEO_CANNIBALIZATION_ACTIONS = {
  target:
    'Marca la página buena como URL objetivo de la palabra, para que el sistema sepa cuál debería salir.',
  consolidate:
    'Consolidar: junta el contenido útil en la página buena y redirige la otra a ella (redirección 301).',
  differentiate:
    'Diferenciar: que cada página trate una búsqueda distinta (título, encabezados y texto) para que no compitan.',
  link: 'Enlazar: desde la otra página, enlaza a la buena con la búsqueda en el texto del enlace.',
  canonical:
    'Si las dos son casi iguales, pon en la débil la etiqueta canónica apuntando a la buena o redirígela.',
  review:
    'Revisa si las dos páginas tienen sentido para esta búsqueda; si es así, márcalo como correcto.',
} as const;

const clampNum = (v: unknown, r: { min: number; max: number }) =>
  typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max;

/** Umbrales guardados con los valores por defecto donde falten o se salgan de rango. */
export function seoCannibalizationThresholdsOf(stored: unknown): SeoCannibalizationThresholds {
  const out = { ...SEO_DEFAULT_CANNIBALIZATION_THRESHOLDS } as SeoCannibalizationThresholds;
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(
      SEO_CANNIBALIZATION_THRESHOLD_RANGES,
    ) as SeoCannibalizationThresholdKey[]) {
      const v = (stored as Record<string, unknown>)[k];
      if (clampNum(v, SEO_CANNIBALIZATION_THRESHOLD_RANGES[k])) out[k] = v as number;
    }
  }
  return out;
}

export interface SeoCannibalizationPageDto {
  page: string;
  clicks: number;
  impressions: number;
  position: number | null;
  impressionsShare: number;
  clicksShare: number | null;
  isTarget: boolean;
  isHome: boolean;
  /** Direcciones juntadas en esta (variantes de la misma URL). */
  variants: string[];
  /** Días que fue la página que más salía. */
  daysOnTop: number;
}

export interface SeoCannibalizationCandidate {
  query: string;
  severity: SeoSeverity;
  kind: SeoCannibalizationKind;
  /** Las páginas que cuentan, de más a menos impresiones. */
  pages: SeoCannibalizationPageDto[];
  /** La página que más salió cada día. */
  timeline: { date: string; page: string }[];
  switches: number;
  /** Es el caso esperado (URL objetivo + portada con poca parte). */
  expected: boolean;
  targetUrl: string | null;
  suggestedUrl: string | null;
  totals: { clicks: number; impressions: number; position: number | null };
  /** Último día en que salieron dos o más páginas. */
  lastDataDate: string | null;
  reason: string;
  action: string;
}

/**
 * Canibalización de una búsqueda en un periodo (§18.5 y §19.2): dos o más
 * páginas propias (sus variantes, juntas) con una parte relevante de las
 * impresiones, o la página principal que cambia varias veces. Fuera las
 * búsquedas de marca. Se clasifica sin darlo por malo:
 * - conflicto: la página ganadora se alterna;
 * - cambio de página: Google ha pasado de una a otra y se ha quedado;
 * - convivencia: las dos salen a la vez en la primera página;
 * - reparto: se reparten las impresiones sin más.
 * Gravedad baja en el caso esperado (la URL objetivo y la portada con poca
 * parte) y en la convivencia; alta si se alternan y la segunda se lleva una
 * parte grande.
 */
export function analyzeSeoCannibalization(input: {
  query: string;
  brandTerms: string[];
  pages: readonly SeoPageMetric[];
  daily: readonly SeoDailyPageRow[];
  targetUrl: string | null;
  thresholds: SeoCannibalizationThresholds;
}): SeoCannibalizationCandidate | null {
  const t = input.thresholds;
  if (isBrandQuery(input.query, input.brandTerms)) return null;
  const merged = mergeSeoPages(input.pages);
  const total = merged.reduce((n, p) => n + p.impressions, 0);
  const totalClicks = merged.reduce((n, p) => n + p.clicks, 0);
  if (total < t.minImpressions) return null;
  const relevant = merged.filter(
    (p) => p.impressions >= t.minPageImpressions && p.impressions / total >= t.minSecondShare,
  );
  if (relevant.length < 2) return null;

  const relevantKeys = new Set(relevant.map((p) => p.key));
  const timeline = seoDailyWinners(input.daily);
  const changes = seoPageChanges(timeline);
  const switches = changes.length;
  const alternating = switches >= t.minSwitches;
  const targetKey = input.targetUrl ? normalizeSeoUrl(input.targetUrl) : null;
  const top = relevant[0]!;
  const second = relevant[1]!;
  const secondShare = second.impressions / total;

  // El caso esperado: la URL objetivo y la portada, que se lleva poco.
  const home = relevant.find((p) => isSeoHomeUrl(p.page));
  const expected =
    !!targetKey &&
    relevant.length === 2 &&
    relevant.some((p) => p.key === targetKey) &&
    !!home &&
    home.key !== targetKey &&
    home.impressions / total < t.homeLowShare;

  // ¿Un cambio estable? La última página lleva al menos 7 días seguidos ganando.
  let trailing = 0;
  const last = timeline[timeline.length - 1];
  for (let k = timeline.length - 1; k >= 0; k--) {
    if (last && sameSeoUrl(timeline[k]!.page, last.page)) trailing++;
    else break;
  }
  const stableSwitch =
    !alternating &&
    switches >= 1 &&
    trailing >= 7 &&
    !!last &&
    !sameSeoUrl(timeline[0]!.page, last.page);
  const bothTopTen =
    top.position !== null &&
    second.position !== null &&
    top.position <= 10 &&
    second.position <= 10;

  const kind: SeoCannibalizationKind = alternating
    ? 'conflict'
    : stableSwitch
      ? 'switch'
      : bothTopTen
        ? 'coexistence'
        : 'split';

  let severity: SeoSeverity;
  if (expected) severity = 'low';
  else if (kind === 'conflict') severity = secondShare >= 0.25 ? 'high' : 'medium';
  else if (kind === 'switch')
    severity = targetKey && last && normalizeSeoUrl(last.page) === targetKey ? 'low' : 'medium';
  else if (kind === 'coexistence') severity = 'low';
  else severity = secondShare >= 0.3 ? 'medium' : 'low';

  const byClicks = [...relevant].sort(
    (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key),
  );
  const suggestedUrl = input.targetUrl ?? byClicks[0]!.page;
  const daysOnTop = new Map<string, number>();
  for (const w of timeline) {
    const k = normalizeSeoUrl(w.page);
    daysOnTop.set(k, (daysOnTop.get(k) ?? 0) + 1);
  }
  const pages: SeoCannibalizationPageDto[] = relevant.map((p) => ({
    page: p.page,
    clicks: p.clicks,
    impressions: p.impressions,
    position: p.position,
    impressionsShare: round3(p.impressions / total),
    clicksShare: totalClicks > 0 ? round3(p.clicks / totalClicks) : null,
    isTarget: !!targetKey && p.key === targetKey,
    isHome: isSeoHomeUrl(p.page),
    variants: p.variants,
    daysOnTop: daysOnTop.get(p.key) ?? 0,
  }));
  // Último día con dos o más de las páginas que cuentan.
  const perDay = new Map<string, Set<string>>();
  for (const r of input.daily) {
    if (r.impressions <= 0) continue;
    const k = normalizeSeoUrl(r.page);
    if (!relevantKeys.has(k)) continue;
    const s = perDay.get(r.date) ?? new Set<string>();
    s.add(k);
    perDay.set(r.date, s);
  }
  const lastDataDate =
    [...perDay.entries()]
      .filter(([, s]) => s.size >= 2)
      .map(([d]) => d)
      .sort()
      .pop() ?? null;
  const w = merged.reduce(
    (acc, p) => (p.position === null ? acc : { w: acc.w + p.position * p.impressions }),
    { w: 0 },
  );
  const candidate = {
    query: input.query,
    severity,
    kind,
    pages,
    timeline,
    switches,
    expected,
    targetUrl: input.targetUrl,
    suggestedUrl,
    totals: {
      clicks: totalClicks,
      impressions: total,
      position: total > 0 ? round1(w.w / total) : null,
    },
    lastDataDate,
    reason: '',
    action: '',
  };
  candidate.reason = seoCannibalizationReason(candidate, t);
  candidate.action = seoCannibalizationAction(candidate);
  return candidate;
}

/** Por qué se marca, en palabras. */
export function seoCannibalizationReason(
  c: Pick<
    SeoCannibalizationCandidate,
    'pages' | 'switches' | 'kind' | 'expected' | 'severity' | 'totals'
  >,
  t: Pick<SeoCannibalizationThresholds, 'periodDays'>,
): string {
  const parts = c.pages
    .slice(0, 3)
    .map(
      (p) =>
        `${shortPath(p.page)} (${pctText(p.impressionsShare)}, posición ${posText(p.position)})`,
    );
  const base = `En los últimos ${t.periodDays} días, ${c.pages.length} páginas tuyas se reparten las ${seoFmtInt(c.totals.impressions)} impresiones de esta búsqueda: ${parts.join(', ')}.`;
  if (c.expected) {
    return `${base} Es lo esperable: tu página objetivo se lleva casi todo y la portada sale de vez en cuando. Gravedad baja.`;
  }
  switch (c.kind) {
    case 'conflict':
      return `${base} La página que más sale ha cambiado ${c.switches} veces: Google no tiene claro cuál enseñar, y eso suele costar posiciones.`;
    case 'switch':
      return `${base} Google ha pasado de una página a otra y se ha quedado con la nueva.`;
    case 'coexistence':
      return `${base} Las dos salen a la vez en la primera página: puede estar bien (por ejemplo, la portada y una ficha).`;
    default:
      return `${base} Ninguna se queda claramente con la búsqueda.`;
  }
}

/** Qué hacer, en palabras. */
export function seoCannibalizationAction(
  c: Pick<SeoCannibalizationCandidate, 'kind' | 'expected' | 'targetUrl' | 'suggestedUrl'>,
): string {
  const A = SEO_CANNIBALIZATION_ACTIONS;
  const target = c.targetUrl
    ? `Tu URL objetivo es ${shortPath(c.targetUrl)}.`
    : `${A.target} Proponemos ${shortPath(c.suggestedUrl ?? '')}, la que más clics lleva.`;
  if (c.expected) return `${A.review} ${A.link}`;
  switch (c.kind) {
    case 'conflict':
      return `${target} ${A.consolidate} O bien ${A.differentiate.charAt(0).toLowerCase()}${A.differentiate.slice(1)} ${A.link}`;
    case 'switch':
      return `${target} Si la nueva es la que quieres, no hace falta más; si no, refuerza la tuya y enlázala desde la otra. ${A.canonical}`;
    case 'coexistence':
      return `${target} ${A.review}`;
    default:
      return `${target} ${A.differentiate} ${A.link}`;
  }
}

function shortPath(url: string): string {
  const { path, params } = splitSeoUrl(url);
  const q = params.length ? `?${params.map(([k, v]) => (v ? `${k}=${v}` : k)).join('&')}` : '';
  return `${path}${q}`;
}

// -------------------------------------------------------------- indexación

export const SEO_INDEX_CATEGORIES = [
  'login',
  'private',
  'technical',
  'params',
  'demo',
  'duplicate',
  'redirect_domain',
  'custom',
  // PR 9: lo que dice la inspección de URL de Google.
  'canonical_mismatch',
  'not_indexed',
] as const;
export type SeoIndexCategory = (typeof SEO_INDEX_CATEGORIES)[number];
export const SEO_INDEX_CATEGORY_LABELS: Record<SeoIndexCategory, string> = {
  login: 'Acceso y registro',
  private: 'Internas y privadas',
  technical: 'Técnicas',
  params: 'Con parámetros',
  demo: 'Pruebas y borradores',
  duplicate: 'Variantes duplicadas',
  redirect_domain: 'Dominio que debería redirigir',
  custom: 'Tus reglas',
  canonical_mismatch: 'Canónica distinta a la declarada',
  not_indexed: 'URL objetivo no indexada',
};

/** Qué hacer con cada categoría. */
export const SEO_INDEX_CATEGORY_ACTIONS: Record<SeoIndexCategory, string> = {
  login:
    'Pon «noindex» en la página (o en sus cabeceras) y quítala del sitemap; si urge, pide la retirada en la herramienta de retirada de URL de Google.',
  private:
    'Es una zona privada: «noindex», bloqueo en robots.txt y fuera del sitemap. Si sale datos de alguien, pide la retirada en Google.',
  technical: 'Bloquéala en robots.txt y quítala del sitemap: no es una página para personas.',
  params:
    'Pon en la página la etiqueta canónica a la versión sin parámetros, o redirige; no enlaces versiones con parámetros.',
  demo: 'Quítala de Google: «noindex» o bórrala, y fuera del sitemap.',
  duplicate:
    'Redirige esta variante (http, www, barra final, mayúsculas o parámetros) a la buena con un 301 y revisa la canónica.',
  redirect_domain:
    'Este dominio debería redirigir: pon una redirección 301 de todas sus páginas a las del dominio principal.',
  custom:
    'Casa con una regla tuya: decide si quitarla de Google («noindex», robots, sitemap) o redirigirla.',
  canonical_mismatch:
    'Revisa la etiqueta canónica de la página, las redirecciones y los enlaces internos para que apunten a la versión que quieres; si Google eligió otra porque son casi iguales, diferencia el contenido o redirige.',
  not_indexed:
    'Corrige el motivo que da Google (noindex, robots.txt, error al leerla, canónica), enlázala desde páginas importantes y pide la indexación en Search Console.',
};

/** Las páginas de acceso y registro (el resto de la lista de la web, privadas). */
const LOGIN_PREFIXES = new Set([
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/reset',
  '/verify-email',
  '/verify',
  '/invite',
  '/security',
]);

/**
 * Reglas por defecto: lo que la web ya marca como no indexable
 * (`WEB_NOINDEX_PREFIXES` y `ROBOTS_PRIVATE_PATHS`, la misma lista que usan el
 * middleware y `robots.txt`), más lo técnico, los borradores y los parámetros.
 * Sintaxis: `/ruta` (esa ruta y lo que cuelga), `?param` (con ese parámetro;
 * `?nombre=` exacto, `?prefijo_` por el principio; `?` solo = cualquier
 * parámetro) y `*texto*` (contiene).
 */
const DEFAULT_RULE_CATEGORIES: [string, SeoIndexCategory][] = [
  ...[...WEB_NOINDEX_PREFIXES, ...ROBOTS_PRIVATE_PATHS, '/reset', '/verify'].map(
    (p): [string, SeoIndexCategory] => [
      p,
      LOGIN_PREFIXES.has(p.replace(/\/$/, '')) ? 'login' : 'private',
    ],
  ),
  ['/api/', 'technical'],
  ['/_next/', 'technical'],
  ['/preview', 'demo'],
  ['/draft', 'demo'],
  ['/borrador', 'demo'],
  ['?preview', 'demo'],
  ['?token=', 'private'],
  ['?utm_', 'params'],
  ['?gclid=', 'params'],
  ['?fbclid=', 'params'],
  ['?', 'params'],
];

export const SEO_DEFAULT_INDEX_RULES: string[] = [
  ...new Map(DEFAULT_RULE_CATEGORIES.map(([p]) => [p, p])).keys(),
];
const DEFAULT_CATEGORY = new Map(DEFAULT_RULE_CATEGORIES);

/** Categoría de una regla (las tuyas, «custom»). */
export function seoIndexRuleCategory(pattern: string): SeoIndexCategory {
  return DEFAULT_CATEGORY.get(pattern) ?? 'custom';
}

/** ¿La URL casa con la regla? */
export function seoIndexRuleMatches(pattern: string, url: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const { path, params } = splitSeoUrl(url);
  const lowerPath = path.toLowerCase();
  if (p === '?') return params.length > 0;
  if (p.startsWith('?')) {
    const exact = p.endsWith('=');
    const name = p.slice(1).replace(/=$/, '').toLowerCase();
    return params.some(([k]) =>
      exact ? k.toLowerCase() === name : k.toLowerCase().startsWith(name),
    );
  }
  if (p.includes('*')) {
    const re = new RegExp(
      `^${p
        .toLowerCase()
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    const full = `${lowerPath}${params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`;
    return re.test(full.toLowerCase());
  }
  if (p.startsWith('/')) return matchesPathPrefix(lowerPath, p.toLowerCase());
  return lowerPath.includes(p.toLowerCase());
}

/** La primera regla con la que casa (las de la lista, en orden). */
export function matchSeoIndexRule(url: string, rules: readonly string[]): string | null {
  for (const r of rules) if (seoIndexRuleMatches(r, url)) return r;
  return null;
}

/** Una página con impresiones en el cruce `page` (todo lo guardado). */
export interface SeoIndexPageRow {
  page: string;
  clicks: number;
  impressions: number;
  firstDate: string;
  lastDate: string;
}

export interface SeoIndexFindingCandidate {
  url: string;
  category: SeoIndexCategory;
  rule: string;
  clicks: number;
  impressions: number;
  firstDate: string;
  lastDate: string;
  reason: string;
  action: string;
}

/**
 * Páginas que aparecen en el rendimiento de Search Console y no deberían
 * estar en Google: casan con una regla, son una variante duplicada de otra o
 * son de un dominio que debería redirigir. «Aparece en el rendimiento» no es
 * «indexación confirmada» (eso lo dice la inspección de URL de Google).
 */
export function detectSeoIndexFindings(input: {
  pages: readonly SeoIndexPageRow[];
  rules: readonly string[];
  /** El dominio está como «redirigido»: todo lo que salga de él es un hallazgo. */
  redirectDomain: boolean;
}): SeoIndexFindingCandidate[] {
  const seen = input.pages.filter((p) => p.impressions > 0 || p.clicks > 0);
  const out: SeoIndexFindingCandidate[] = [];
  const flagged = new Set<string>();
  const add = (p: SeoIndexPageRow, category: SeoIndexCategory, rule: string, why: string) => {
    flagged.add(p.page);
    out.push({
      url: p.page,
      category,
      rule,
      clicks: p.clicks,
      impressions: p.impressions,
      firstDate: p.firstDate,
      lastDate: p.lastDate,
      reason: `Aparece en el rendimiento de Search Console (${seoFmtInt(p.impressions)} impresiones y ${seoFmtInt(p.clicks)} clics entre el ${p.firstDate} y el ${p.lastDate}) y ${why}.`,
      action: SEO_INDEX_CATEGORY_ACTIONS[category],
    });
  };
  if (input.redirectDomain) {
    for (const p of seen)
      add(
        p,
        'redirect_domain',
        'dominio redirigido',
        'es de un dominio que debería redirigir al principal',
      );
    return out;
  }
  for (const p of seen) {
    const rule = matchSeoIndexRule(p.page, input.rules);
    if (rule) add(p, seoIndexRuleCategory(rule), rule, `casa con la regla «${rule}»`);
  }
  // Variantes de una misma página: la de más impresiones es la buena.
  const groups = new Map<string, SeoIndexPageRow[]>();
  for (const p of seen) {
    const k = normalizeSeoUrl(p.page);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) =>
        b.impressions - a.impressions || b.clicks - a.clicks || a.page.localeCompare(b.page),
    );
    const main = sorted[0]!;
    for (const v of sorted.slice(1)) {
      if (flagged.has(v.page)) continue;
      add(v, 'duplicate', `variante de ${main.page}`, `es una variante de ${main.page}`);
    }
  }
  return out;
}

// --------------------------------------------------- estados y ajustes

export const SEO_DIAGNOSTIC_STATUSES = ['new', 'reviewed', 'fixed', 'ok'] as const;
export type SeoDiagnosticStatus = (typeof SEO_DIAGNOSTIC_STATUSES)[number];
export const SeoDiagnosticStatusEnum = z.enum(SEO_DIAGNOSTIC_STATUSES);
export const SEO_DIAGNOSTIC_STATUS_LABELS: Record<SeoDiagnosticStatus, string> = {
  new: 'Nueva',
  reviewed: 'Revisada',
  fixed: 'Arreglada',
  ok: 'Es correcta',
};
/** Las que siguen pendientes (las que se enseñan por defecto). */
export const SEO_DIAGNOSTIC_OPEN_STATUSES: SeoDiagnosticStatus[] = ['new', 'reviewed'];

export const UpdateSeoDiagnosticSchema = z
  .object({
    status: SeoDiagnosticStatusEnum,
    notes: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((v) => v.status !== undefined || v.notes !== undefined, {
    message: 'No hay nada que cambiar.',
  });
export type UpdateSeoDiagnosticInput = z.infer<typeof UpdateSeoDiagnosticSchema>;

const cannibalizationShape = Object.fromEntries(
  (Object.keys(SEO_CANNIBALIZATION_THRESHOLD_RANGES) as SeoCannibalizationThresholdKey[]).map(
    (k) => {
      const r = SEO_CANNIBALIZATION_THRESHOLD_RANGES[k];
      const base = z.number().min(r.min).max(r.max);
      return [k, (r.integer ? base.int() : base).optional()];
    },
  ),
) as { [K in SeoCannibalizationThresholdKey]: z.ZodOptional<z.ZodNumber> };

export const UpdateSeoDiagnosticSettingsSchema = z.object({
  cannibalization: z.object(cannibalizationShape).optional(),
  /** Reglas de indexación (sustituyen a las de por defecto). */
  indexRules: z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .transform((list) => [...new Set(list)])
    .optional(),
  /** Vuelve a los umbrales y reglas por defecto. */
  reset: z.boolean().optional(),
});
export type UpdateSeoDiagnosticSettingsInput = z.infer<typeof UpdateSeoDiagnosticSettingsSchema>;

/** Ajustes guardados en `seo_projects.diagnostic_settings` con sus valores por defecto. */
export function seoDiagnosticSettingsOf(stored: unknown): {
  cannibalization: SeoCannibalizationThresholds;
  indexRules: string[];
  customIndexRules: boolean;
} {
  const s = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const rules = Array.isArray(s.indexRules)
    ? s.indexRules.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : null;
  return {
    cannibalization: seoCannibalizationThresholdsOf(s.cannibalization),
    indexRules: rules ?? [...SEO_DEFAULT_INDEX_RULES],
    customIndexRules: rules !== null,
  };
}

export interface SeoDiagnosticSettingsDto {
  cannibalization: SeoCannibalizationThresholds;
  indexRules: string[];
  /** Las reglas son las tuyas (si no, las de por defecto). */
  customIndexRules: boolean;
  defaults: { cannibalization: SeoCannibalizationThresholds; indexRules: string[] };
}

// ------------------------------------------------------------------ DTOs

export interface SeoDiagnosticBaseDto {
  id: string;
  projectId: string;
  domain: string;
  status: SeoDiagnosticStatus;
  notes: string | null;
  /** Sigue saliendo en el último cálculo. */
  active: boolean;
  /** Se dio por arreglada y ha vuelto a salir. */
  returnedAt: string | null;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface SeoCannibalizationDto extends SeoDiagnosticBaseDto {
  query: string;
  severity: SeoSeverity;
  kind: SeoCannibalizationKind;
  expected: boolean;
  pages: SeoCannibalizationPageDto[];
  timeline: { date: string; page: string }[];
  switches: number;
  targetUrl: string | null;
  suggestedUrl: string | null;
  totals: { clicks: number; impressions: number; position: number | null };
  period: { from: string; to: string };
  lastDataDate: string | null;
  reason: string;
  action: string;
}

export interface SeoIndexFindingDto extends SeoDiagnosticBaseDto {
  url: string;
  category: SeoIndexCategory;
  rule: string;
  clicks: number;
  impressions: number;
  /** Primer y último día con impresiones (fechas de Google). */
  firstDate: string;
  lastDate: string;
  /**
   * De dónde sale: «aparece en el rendimiento» (reglas sobre lo que tiene
   * impresiones) o la inspección de URL de Google (PR 9).
   */
  evidence: 'performance' | 'inspection';
  reason: string;
  action: string;
  /** Lo que dice Google de esta URL en su última inspección (si la hay). */
  inspection: SeoUrlIndexStatusDto | null;
}

export const SEO_INDEX_EVIDENCE_LABELS = {
  performance: 'Aparece en el rendimiento de Search Console',
  inspection: 'Lo dice la inspección de URL de Google',
  confirmed: 'Indexación confirmada',
} as const;
export const SEO_INDEX_EVIDENCE_NOTE =
  'Que una página aparezca en el rendimiento de Search Console (ha tenido impresiones) es una señal fuerte de que Google la tiene, pero no una confirmación. La indexación confirmada sale de la inspección de URL de Google, que tiene cuota diaria: se lanza a mano o sobre las URL importantes.';

export interface SeoDiagnosticListDto<T> {
  calculatedAt: string | null;
  total: number;
  items: T[];
}

export interface SeoCannibalizationSummaryDto {
  calculatedAt: string | null;
  /** Pendientes (nuevas y revisadas) que siguen saliendo. */
  open: number;
  bySeverity: Record<SeoSeverity, number>;
  byKind: Record<SeoCannibalizationKind, number>;
  byStatus: Record<SeoDiagnosticStatus, number>;
}

export interface SeoIndexSummaryDto {
  calculatedAt: string | null;
  open: number;
  byCategory: Record<SeoIndexCategory, number>;
  byStatus: Record<SeoDiagnosticStatus, number>;
}

export interface SeoSitemapRowDto {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isIndex: boolean;
  submitted: number;
  warnings: number;
  errors: number;
  /** El propio sitemap casa con una regla (no debería estar enviado). */
  matchesRule: string | null;
}

export interface SeoSitemapsDto {
  fetchedAt: string;
  domains: {
    domainId: string;
    domain: string;
    error: string | null;
    sitemaps: SeoSitemapRowDto[];
  }[];
}

export interface SeoDiagnosticsRecalcDto {
  calculatedAt: string;
  cannibalization: { detected: number; created: number; returned: number; gone: number };
  index: { detected: number; created: number; returned: number; gone: number };
}

// --------------------------------------------------------- palabras seguidas

export const SEO_TRACKED_PERIODS = [7, 28, 90] as const;
export type SeoTrackedPeriod = (typeof SEO_TRACKED_PERIODS)[number];
export const isSeoTrackedPeriod = (n: unknown): n is SeoTrackedPeriod =>
  (SEO_TRACKED_PERIODS as readonly unknown[]).includes(n);

export interface SeoTrackedKeywordDto {
  id: string;
  keyword: string;
  groupName: string | null;
  /** La intención que se usa (la tuya, la de SISTRIX o la deducida). */
  intent: SeoKeywordIntent | null;
  intentSource: SeoIntentSource | null;
  /** La que pusiste a mano (la que se edita). */
  manualIntent: SeoKeywordIntent | null;
  targetUrl: string | null;
  priority: number;
  notes: string | null;
  strategyLocked: boolean;
  source: SeoKeywordSource;
  isActive: boolean;
  createdAt: string;
  /** Si la creó un maestro: cuándo se importó. */
  masterImportedAt: string | null;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  previousPosition: number | null;
  /** Puestos que sube frente al periodo anterior (positivo = mejor). */
  positionDiff: number | null;
  /** La página que más sale en Google para esta búsqueda. */
  googlePage: string | null;
  targetStatus: SeoTargetStatus;
  targetShare: number | null;
  topShare: number | null;
  suggestedUrl: string | null;
  /** Volumen estimado de SISTRIX (búsquedas al mes; nacional). */
  volume: number | null;
  volumeOrigin: SeoDataOriginDto | null;
  /** Lo que dice Google de la URL objetivo en su última inspección (si la hay). */
  targetIndex: SeoUrlIndexStatusDto | null;
}

export interface SeoTrackedGroupDto {
  key: string;
  label: string;
  keywords: number;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface SeoTrackedKeywordsDto {
  domainId: string | null;
  domain: string | null;
  days: number;
  lastDate: string | null;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  comparable: boolean;
  items: SeoTrackedKeywordDto[];
  byIntent: SeoTrackedGroupDto[];
  byGroup: SeoTrackedGroupDto[];
  targetSummary: Record<SeoTargetStatus, number>;
  count: number;
  limit: number;
}

export interface SeoTrackedKeywordDetailDto {
  keyword: SeoTrackedKeywordDto;
  domain: string | null;
  from: string;
  to: string;
  daily: {
    date: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
    page: string | null;
  }[];
  /** Días en que cambia la página que más sale. */
  pageChanges: { date: string; from: string; to: string }[];
  pages: (SeoPageMetric & { ctr: number | null; share: number; isTarget: boolean })[];
  devices: {
    device: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
  }[];
  countries: {
    country: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
  }[];
  /** Posición estimada de SISTRIX (nacional), serie aparte. */
  sistrix: {
    points: { date: string; position: number; url: string; provider: SeoProviderKey }[];
    origin: SeoDataOriginDto | null;
  };
}

export const SEO_NO_GROUP = '';
export const SEO_NO_INTENT = 'none';

/** Totales por intención o por grupo (posición ponderada por impresiones). */
export function seoGroupTrackedKeywords(
  items: readonly Pick<
    SeoTrackedKeywordDto,
    'intent' | 'groupName' | 'clicks' | 'impressions' | 'position'
  >[],
  by: 'intent' | 'group',
  labels: { intent: Record<string, string>; none: string },
): SeoTrackedGroupDto[] {
  const groups = new Map<
    string,
    { n: number; c: number; i: number; w: number; ps: number; np: number }
  >();
  for (const k of items) {
    const key = by === 'intent' ? (k.intent ?? SEO_NO_INTENT) : (k.groupName ?? SEO_NO_GROUP);
    const g = groups.get(key) ?? { n: 0, c: 0, i: 0, w: 0, ps: 0, np: 0 };
    g.n += 1;
    g.c += k.clicks;
    g.i += k.impressions;
    if (k.position !== null) {
      g.w += k.position * k.impressions;
      g.ps += k.position;
      g.np += 1;
    }
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label:
        by === 'intent'
          ? key === SEO_NO_INTENT
            ? labels.none
            : (labels.intent[key] ?? key)
          : key === SEO_NO_GROUP
            ? labels.none
            : key,
      keywords: g.n,
      clicks: g.c,
      impressions: g.i,
      ctr: g.i > 0 ? round3(g.c / g.i) : null,
      position: g.np === 0 ? null : round1(g.i > 0 ? g.w / g.i : g.ps / g.np),
    }))
    .sort(
      (a, b) =>
        b.impressions - a.impressions || b.clicks - a.clicks || a.label.localeCompare(b.label),
    );
}

/** La intención que se usa en la vista: manual > SISTRIX > reglas (la función de la PR 4). */
export function seoTrackedIntent(input: {
  manual: SeoKeywordIntent | null;
  sistrix: SeoKeywordIntent | null;
  keyword: string;
}) {
  return seoResolveIntent({ manual: input.manual, sistrix: input.sistrix, query: input.keyword });
}

// ------------------------------------------------- alta desde Search Console

export interface SeoKeywordCandidateDto {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  brand: boolean;
  tracked: boolean;
  /** Deducida del texto (reglas): se puede cambiar al añadirla. */
  intent: SeoKeywordIntent | null;
}

export interface SeoKeywordCandidatesDto {
  domain: string | null;
  from: string;
  to: string;
  items: SeoKeywordCandidateDto[];
  /** Búsquedas que cumplen los filtros (se enseñan las primeras). */
  total: number;
}

export const SEO_KEYWORD_CANDIDATES_MAX = 500;

// ------------------------------------------------------- alta desde CSV

export const SEO_KEYWORD_IMPORT_FIELDS = [
  'keyword',
  'groupName',
  'intent',
  'targetUrl',
  'priority',
  'notes',
] as const;
export type SeoKeywordImportField = (typeof SEO_KEYWORD_IMPORT_FIELDS)[number];

/** Cabecera sin tildes, espacios ni mayúsculas (como el importador general). */
export function normalizeSeoImportHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_-]+/g, '');
}

/** Nombres de columna admitidos (normalizados). */
export const SEO_KEYWORD_IMPORT_ALIASES: Record<string, SeoKeywordImportField> = {
  palabra: 'keyword',
  palabraclave: 'keyword',
  palabrasclave: 'keyword',
  keyword: 'keyword',
  keywords: 'keyword',
  consulta: 'keyword',
  busqueda: 'keyword',
  query: 'keyword',
  termino: 'keyword',
  grupo: 'groupName',
  group: 'groupName',
  cluster: 'groupName',
  categoria: 'groupName',
  intencion: 'intent',
  intent: 'intent',
  urlobjetivo: 'targetUrl',
  paginaobjetivo: 'targetUrl',
  targeturl: 'targetUrl',
  url: 'targetUrl',
  pagina: 'targetUrl',
  landing: 'targetUrl',
  prioridad: 'priority',
  priority: 'priority',
  notas: 'notes',
  nota: 'notes',
  notes: 'notes',
  comentarios: 'notes',
};

const INTENT_WORDS: Record<string, SeoKeywordIntent> = {
  know: 'know',
  informativa: 'know',
  informacional: 'know',
  informarse: 'know',
  informational: 'know',
  do: 'do',
  comercial: 'do',
  transaccional: 'do',
  contratar: 'do',
  comprar: 'do',
  commercial: 'do',
  transactional: 'do',
  visit: 'visit',
  local: 'visit',
  visita: 'visit',
  iraunsitio: 'visit',
  website: 'website',
  navegacion: 'website',
  navegacional: 'website',
  marca: 'website',
  navigational: 'website',
  buscarunaweb: 'website',
};

/** Intención escrita en el fichero (en castellano o en inglés). */
export function parseSeoIntent(value: string | undefined): SeoKeywordIntent | null | 'invalid' {
  const v = normalizeSeoImportHeader(value ?? '');
  if (!v) return null;
  return (
    INTENT_WORDS[v] ??
    (SeoKeywordIntentEnum.safeParse(v).success ? (v as SeoKeywordIntent) : 'invalid')
  );
}

/** Prioridad escrita en el fichero: alta/media/baja o 1/2/3. */
export function parseSeoPriority(value: string | undefined): 1 | 2 | 3 | null | 'invalid' {
  const v = normalizeSeoImportHeader(value ?? '');
  if (!v) return null;
  if (v === '1' || v === 'alta' || v === 'high') return 1;
  if (v === '2' || v === 'media' || v === 'medium' || v === 'normal') return 2;
  if (v === '3' || v === 'baja' || v === 'low') return 3;
  return 'invalid';
}

const URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/i;

export interface SeoKeywordImportInputRow {
  /** Línea del fichero (la cabecera es la 1). */
  line: number;
  keyword?: string | undefined;
  groupName?: string | undefined;
  intent?: string | undefined;
  targetUrl?: string | undefined;
  priority?: string | undefined;
  notes?: string | undefined;
}

/** Lo que ya hay de una palabra en el proyecto. */
export interface SeoKeywordImportExisting {
  groupName: string | null;
  intent: SeoKeywordIntent | null;
  targetUrl: string | null;
  notes: string | null;
  strategyLocked: boolean;
}

export type SeoKeywordImportAction = 'create' | 'update' | 'unchanged' | 'locked' | 'error';
export const SEO_KEYWORD_IMPORT_ACTION_LABELS: Record<SeoKeywordImportAction, string> = {
  create: 'Nueva',
  update: 'Se completa',
  unchanged: 'Sin cambios',
  locked: 'Decisión fijada (no se toca)',
  error: 'Con error',
};
export type SeoKeywordImportChange = 'groupName' | 'intent' | 'targetUrl' | 'notes';
export const SEO_KEYWORD_IMPORT_CHANGE_LABELS: Record<SeoKeywordImportChange, string> = {
  groupName: 'grupo',
  intent: 'intención',
  targetUrl: 'URL objetivo',
  notes: 'notas',
};

export interface SeoKeywordImportItemDto {
  line: number;
  keyword: string;
  action: SeoKeywordImportAction;
  /** Lo que se rellena (solo campos vacíos). */
  changes: SeoKeywordImportChange[];
  error: string | null;
  data: {
    groupName: string | null;
    intent: SeoKeywordIntent | null;
    targetUrl: string | null;
    priority: 1 | 2 | 3 | null;
    notes: string | null;
  };
}

export interface SeoKeywordImportPlan {
  items: SeoKeywordImportItemDto[];
  counts: Record<SeoKeywordImportAction, number>;
}

/**
 * Plan de una importación de palabras: nuevas, las que se completan, las que
 * no cambian y los errores. Nunca pisa: una palabra con la decisión fijada no
 * se toca, y en las demás solo se rellena lo que está vacío (grupo,
 * intención, URL objetivo y notas). La prioridad solo entra en las nuevas.
 */
export function planSeoKeywordImport(input: {
  rows: readonly SeoKeywordImportInputRow[];
  existing: ReadonlyMap<string, SeoKeywordImportExisting>;
}): SeoKeywordImportPlan {
  const items: SeoKeywordImportItemDto[] = [];
  const seen = new Set<string>();
  for (const r of input.rows) {
    const keyword = normalizeSeoKeyword(r.keyword ?? '');
    const intent = parseSeoIntent(r.intent);
    const priority = parseSeoPriority(r.priority);
    const targetUrl = (r.targetUrl ?? '').trim();
    const groupName = (r.groupName ?? '').trim().slice(0, 80) || null;
    const notes = (r.notes ?? '').trim().slice(0, 1000) || null;
    const data = {
      groupName,
      intent: intent === 'invalid' ? null : intent,
      targetUrl: targetUrl || null,
      priority: priority === 'invalid' ? null : priority,
      notes,
    };
    const fail = (error: string) =>
      items.push({ line: r.line, keyword, action: 'error', changes: [], error, data });
    if (keyword.length < 2) {
      fail('Falta la palabra (o tiene menos de 2 letras).');
      continue;
    }
    if (keyword.length > 120) {
      fail('La palabra pasa de 120 caracteres.');
      continue;
    }
    if (seen.has(keyword)) {
      fail('Está repetida en el fichero (vale la primera).');
      continue;
    }
    seen.add(keyword);
    if (intent === 'invalid') {
      fail(`No se entiende la intención «${r.intent}» (informativa, comercial, local o marca).`);
      continue;
    }
    if (priority === 'invalid') {
      fail(`No se entiende la prioridad «${r.priority}» (alta, media, baja o 1, 2, 3).`);
      continue;
    }
    if (targetUrl && (!URL_RE.test(targetUrl) || targetUrl.length > 500)) {
      fail('La URL objetivo tiene que empezar por https:// (o http://).');
      continue;
    }
    const prev = input.existing.get(keyword);
    if (!prev) {
      items.push({ line: r.line, keyword, action: 'create', changes: [], error: null, data });
      continue;
    }
    if (prev.strategyLocked) {
      items.push({ line: r.line, keyword, action: 'locked', changes: [], error: null, data });
      continue;
    }
    const changes: SeoKeywordImportChange[] = [];
    if (!prev.groupName && data.groupName) changes.push('groupName');
    if (!prev.intent && data.intent) changes.push('intent');
    if (!prev.targetUrl && data.targetUrl) changes.push('targetUrl');
    if (!prev.notes && data.notes) changes.push('notes');
    items.push({
      line: r.line,
      keyword,
      action: changes.length ? 'update' : 'unchanged',
      changes,
      error: null,
      data,
    });
  }
  const counts = { create: 0, update: 0, unchanged: 0, locked: 0, error: 0 };
  for (const i of items) counts[i.action] += 1;
  return { items, counts };
}

export const SeoKeywordImportSchema = z.object({
  /** Texto del CSV o, con `xlsx`, el fichero en base64. */
  content: z.string().min(1).max(3_000_000),
  format: ImportFormatEnum.default('csv'),
});
export type SeoKeywordImportInput = z.infer<typeof SeoKeywordImportSchema>;
export type SeoKeywordImportRequest = z.input<typeof SeoKeywordImportSchema>;

export interface SeoKeywordImportPreviewDto {
  items: SeoKeywordImportItemDto[];
  counts: Record<SeoKeywordImportAction, number>;
  /** Columnas reconocidas y las que no se usan. */
  columns: { name: string; field: SeoKeywordImportField | null }[];
  current: number;
  limit: number;
  /** Las nuevas no caben en el límite de palabras. */
  overLimit: boolean;
}

export interface SeoKeywordImportResultDto {
  created: number;
  updated: number;
  unchanged: number;
  locked: number;
  errors: number;
}

export const SEO_KEYWORD_SOURCE_LABELS: Record<SeoKeywordSource, string> = {
  manual: 'A mano',
  sistrix_ideas: 'Ideas de SISTRIX',
  sistrix_opportunities: 'Oportunidades de SISTRIX',
  import: 'Importada',
  search_console: 'Search Console',
  opportunity: 'Oportunidad',
  master: 'Del maestro',
};
