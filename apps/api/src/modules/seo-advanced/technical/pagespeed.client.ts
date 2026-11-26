import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type SeoFieldCategory,
  type SeoPageSpeedFieldDto,
  type SeoPageSpeedOpportunityDto,
  type SeoPageSpeedStrategy,
} from '@storageos/shared';

import type { Env } from '../../../config/env.schema';

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
/** Las cuatro categorías de Lighthouse: cuestan lo mismo que solo rendimiento. */
const CATEGORIES = ['performance', 'seo', 'accessibility', 'best-practices'] as const;
/** PageSpeed tarda 10-30 segundos (a veces más): un minuto por intento. */
const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;
/** Mejoras que se guardan (las de más ahorro). */
const MAX_OPPORTUNITIES = 8;
/** Auditorías que son las propias métricas (no son «mejoras»). */
const METRIC_AUDITS = new Set([
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'first-contentful-paint',
  'speed-index',
  'interactive',
  'max-potential-fid',
  'first-meaningful-paint',
]);

/** Error de PageSpeed con su código HTTP (0 = sin respuesta o tiempo agotado). */
export class PageSpeedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Se puede reintentar: límite de peticiones, error de Google o sin respuesta. */
export const isPageSpeedTransient = (err: unknown): err is PageSpeedError =>
  err instanceof PageSpeedError && (err.status === 0 || err.status === 429 || err.status >= 500);

export interface PageSpeedResult {
  finalUrl: string | null;
  analyzedAt: string;
  scores: {
    performance: number | null;
    seo: number | null;
    accessibility: number | null;
    bestPractices: number | null;
  };
  lab: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
    fcpMs: number | null;
    siMs: number | null;
    ttiMs: number | null;
  };
  /** Datos de campo que se enseñan (los de la URL o, si no hay, los del sitio). */
  field: SeoPageSpeedFieldDto | null;
  /** Los dos tal cual (URL y origen), para guardarlos. */
  fieldRaw: { url: SeoPageSpeedFieldDto | null; origin: SeoPageSpeedFieldDto | null };
  opportunities: SeoPageSpeedOpportunityDto[];
}

interface RawMetric {
  percentile?: number;
  category?: string;
}
interface RawExperience {
  metrics?: Record<string, RawMetric | undefined>;
  overall_category?: string;
  origin_fallback?: boolean;
}
interface RawAudit {
  id?: string;
  title?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  displayValue?: string;
  details?: { type?: string; overallSavingsMs?: number };
  metricSavings?: Record<string, number | undefined>;
}
export interface RawPageSpeed {
  id?: string;
  analysisUTCTimestamp?: string;
  loadingExperience?: RawExperience;
  originLoadingExperience?: RawExperience;
  lighthouseResult?: {
    finalUrl?: string;
    categories?: Record<string, { score?: number | null } | undefined>;
    audits?: Record<string, RawAudit | undefined>;
  };
}

const category = (v: string | undefined): SeoFieldCategory | null =>
  v === 'FAST' || v === 'AVERAGE' || v === 'SLOW' || v === 'NONE' ? v : null;
const int = (n: number | undefined | null) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;

function experience(e: RawExperience | undefined, scope: 'url' | 'origin') {
  const m = e?.metrics;
  if (!m || Object.keys(m).length === 0) return null;
  const lcp = m.LARGEST_CONTENTFUL_PAINT_MS;
  const inp = m.INTERACTION_TO_NEXT_PAINT;
  const cls = m.CUMULATIVE_LAYOUT_SHIFT_SCORE;
  return {
    scope,
    overall: category(e?.overall_category),
    lcpMs: int(lcp?.percentile),
    lcpCategory: category(lcp?.category),
    inpMs: int(inp?.percentile),
    inpCategory: category(inp?.category),
    // Google da el CLS multiplicado por 100.
    cls: typeof cls?.percentile === 'number' ? Math.round(cls.percentile) / 100 : null,
    clsCategory: category(cls?.category),
  } satisfies SeoPageSpeedFieldDto;
}

/** Respuesta de PageSpeed → lo que se guarda (sin suponer campos que pueden faltar). */
export function parsePageSpeed(raw: RawPageSpeed): PageSpeedResult {
  const lh = raw.lighthouseResult ?? {};
  const cats = lh.categories ?? {};
  const audits = lh.audits ?? {};
  const score = (k: string) => {
    const s = cats[k]?.score;
    return typeof s === 'number' ? Math.round(s * 100) : null;
  };
  const num = (k: string) => audits[k]?.numericValue;
  // Si la URL no tiene bastantes visitas, Google rellena `loadingExperience` con el origen.
  const urlField = raw.loadingExperience?.origin_fallback
    ? null
    : experience(raw.loadingExperience, 'url');
  const originField = experience(raw.originLoadingExperience, 'origin');
  const opportunities = Object.entries(audits)
    .map(([id, a]) => ({ id, a: a ?? {} }))
    .filter(
      ({ id, a }) =>
        !METRIC_AUDITS.has(id) &&
        typeof a.score === 'number' &&
        a.score < 0.9 &&
        a.scoreDisplayMode !== 'informative' &&
        a.scoreDisplayMode !== 'notApplicable' &&
        a.scoreDisplayMode !== 'manual' &&
        !!a.title,
    )
    .map(({ id, a }) => {
      const metric = Object.values(a.metricSavings ?? {}).filter(
        (n): n is number => typeof n === 'number',
      );
      const savings =
        a.details?.overallSavingsMs ?? (metric.length > 0 ? Math.max(...metric) : null);
      return {
        id,
        title: a.title!,
        savingsMs: savings !== null && savings > 0 ? Math.round(savings) : null,
        displayValue: a.displayValue ?? null,
        score: a.score ?? 0,
      };
    })
    .sort((x, y) => (y.savingsMs ?? 0) - (x.savingsMs ?? 0) || x.score - y.score)
    .slice(0, MAX_OPPORTUNITIES)
    .map(({ score: _score, ...o }) => o);
  return {
    finalUrl: lh.finalUrl ?? raw.id ?? null,
    analyzedAt: raw.analysisUTCTimestamp ?? new Date().toISOString(),
    scores: {
      performance: score('performance'),
      seo: score('seo'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
    },
    lab: {
      lcpMs: int(num('largest-contentful-paint')),
      cls:
        typeof num('cumulative-layout-shift') === 'number'
          ? Math.round(num('cumulative-layout-shift')! * 1000) / 1000
          : null,
      tbtMs: int(num('total-blocking-time')),
      fcpMs: int(num('first-contentful-paint')),
      siMs: int(num('speed-index')),
      ttiMs: int(num('interactive')),
    },
    field: urlField ?? originField,
    fieldRaw: { url: urlField, origin: originField },
    opportunities,
  };
}

/**
 * PageSpeed Insights (v5) con la clave opcional `PAGESPEED_API_KEY` (sin ella
 * Google deja muy pocas peticiones). Una petición por URL y estrategia, con
 * las cuatro categorías de Lighthouse y los textos en español. Reintenta con
 * espera creciente ante 429, 5xx o tiempo agotado.
 *
 * Con `NODE_ENV=test` o `PAGESPEED_MODE=stub` funciona simulado: una URL con
 * `slow` es lenta (también para los usuarios reales), con `nofield` no tiene
 * datos de campo de la URL (solo del sitio) y con `psierror` falla.
 */
@Injectable()
export class PageSpeedClient {
  /** Espera base entre reintentos (ms); se dobla en cada intento. */
  retryBaseMs = 5000;
  /** Tiempo máximo de cada intento (ms). */
  timeoutMs = TIMEOUT_MS;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get stub(): boolean {
    return (
      process.env.NODE_ENV === 'test' ||
      this.config.get('PAGESPEED_MODE', { infer: true }) === 'stub'
    );
  }

  get keyConfigured(): boolean {
    return !!this.config.get('PAGESPEED_API_KEY', { infer: true });
  }

  async run(url: string, strategy: SeoPageSpeedStrategy): Promise<PageSpeedResult> {
    if (this.stub) return stubPageSpeed(url, strategy);
    const params = new URLSearchParams({ url, strategy, locale: 'es' });
    for (const c of CATEGORIES) params.append('category', c);
    const key = this.config.get('PAGESPEED_API_KEY', { infer: true });
    if (key) params.set('key', key);
    for (let attempt = 1; ; attempt++) {
      try {
        return parsePageSpeed(await this.fetchOnce(`${API}?${params.toString()}`));
      } catch (err) {
        if (!isPageSpeedTransient(err) || attempt >= ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, this.retryBaseMs * 2 ** (attempt - 1)));
      }
    }
  }

  private async fetchOnce(url: string): Promise<RawPageSpeed> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const name = (err as Error).name;
      throw new PageSpeedError(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'PageSpeed no respondió a tiempo'
          : `Sin respuesta de PageSpeed: ${(err as Error).message}`,
        0,
      );
    }
    const json = (await res.json().catch(() => ({}))) as RawPageSpeed & {
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new PageSpeedError(json.error?.message ?? `PageSpeed: ${res.status}`, res.status);
    }
    return json;
  }
}

/** Mediciones simuladas, deterministas por la URL y la estrategia. */
function stubPageSpeed(url: string, strategy: SeoPageSpeedStrategy): PageSpeedResult {
  const u = url.toLowerCase();
  if (u.includes('psierror')) {
    throw new PageSpeedError('Lighthouse returned error: FAILED_DOCUMENT_REQUEST', 400);
  }
  const seed = createHash('sha1').update(u).digest()[0]! % 10;
  const slow = u.includes('slow');
  const desktop = strategy === 'desktop';
  const perf = slow ? (desktop ? 55 : 35) : Math.min(100, (desktop ? 88 : 72) + seed);
  const lcp = slow ? 6200 : desktop ? 1400 + seed * 50 : 2300 + seed * 80;
  const field = (scope: 'url' | 'origin'): SeoPageSpeedFieldDto => ({
    scope,
    overall: slow ? 'SLOW' : 'FAST',
    lcpMs: slow ? 5200 : 2100,
    lcpCategory: slow ? 'SLOW' : 'FAST',
    inpMs: slow ? 650 : 150,
    inpCategory: slow ? 'SLOW' : 'FAST',
    cls: slow ? 0.3 : 0.04,
    clsCategory: slow ? 'SLOW' : 'FAST',
  });
  const urlField = u.includes('nofield') ? null : field('url');
  const originField = field('origin');
  return {
    finalUrl: url,
    analyzedAt: new Date().toISOString(),
    scores: { performance: perf, seo: 92, accessibility: 88 + (seed % 5), bestPractices: 96 },
    lab: {
      lcpMs: lcp,
      cls: slow ? 0.28 : 0.02,
      tbtMs: slow ? 900 : desktop ? 40 : 180,
      fcpMs: slow ? 3200 : desktop ? 700 : 1500,
      siMs: slow ? 6100 : desktop ? 1300 : 2900,
      ttiMs: slow ? 9000 : desktop ? 1800 : 4200,
    },
    field: urlField ?? originField,
    fieldRaw: { url: urlField, origin: originField },
    opportunities: [
      {
        id: 'uses-optimized-images',
        title: 'Codifica las imágenes de forma eficiente',
        savingsMs: slow ? 1800 : 300,
        displayValue: slow ? 'Ahorro potencial de 420 KiB' : 'Ahorro potencial de 60 KiB',
      },
      {
        id: 'render-blocking-resources',
        title: 'Elimina los recursos que bloquean el renderizado',
        savingsMs: slow ? 1200 : 150,
        displayValue: null,
      },
    ],
  };
}
