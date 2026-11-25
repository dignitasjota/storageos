import { describe, expect, it } from 'vitest';

import {
  SEO_DEFAULT_OPPORTUNITY_THRESHOLDS,
  SEO_DEFAULT_WEIGHTS,
  UpdateSeoOpportunitySettingsSchema,
  UpdateSeoOpportunitySchema,
  detectSeoOpportunities,
  isCommercialIntent,
  scoreSeoOpportunity,
  seoFmtInt,
  seoResolveIntent,
  seoRuleIntent,
  seoSistrixIntent,
  seoThresholdsOf,
  seoWeightsOf,
  type SeoOpportunityDetectInput,
  type SeoOpportunityFactorsInput,
  type SeoOpportunityKeywordRow,
  type SeoOpportunityQueryRow,
} from './opportunities';

const PERIOD = {
  from: '2026-10-01',
  to: '2026-10-28',
  previousFrom: '2026-09-03',
  previousTo: '2026-09-30',
  comparable: true,
};
const ORIGIN = {
  provider: 'sistrix_mcp' as const,
  fetchedAt: '2026-10-20T08:00:00.000Z',
  dataDate: '2026-10-19',
};

const q = (
  query: string,
  impressions: number,
  position: number,
  clicks = Math.round(impressions * 0.05),
  previous: SeoOpportunityQueryRow['previous'] = null,
): SeoOpportunityQueryRow => ({ query, clicks, impressions, position, previous });

function detect(over: Partial<SeoOpportunityDetectInput> = {}) {
  return detectSeoOpportunities({
    domain: 'ejemplo.es',
    brandTerms: ['guardalo'],
    weights: { ...SEO_DEFAULT_WEIGHTS },
    thresholds: { ...SEO_DEFAULT_OPPORTUNITY_THRESHOLDS },
    period: PERIOD,
    queries: [],
    keywords: [],
    sistrixMetricsAvailable: false,
    sistrixOpportunities: [],
    keywordGaps: [],
    ...over,
  });
}
const types = (list: { type: string; query: string }[], query: string) =>
  list
    .filter((o) => o.query === query)
    .map((o) => o.type)
    .sort();

const base: SeoOpportunityFactorsInput = {
  impressions: 400,
  clicks: 20,
  volume: null,
  position: 6,
  ctr: 0.05,
  intent: null,
  priority: null,
  positionDiff: null,
  impressionsPct: null,
  competition: null,
  hasGsc: true,
  hasSistrix: false,
  comparable: false,
};

describe('intención', () => {
  it('reglas sobre el texto', () => {
    expect(seoRuleIntent('precio trastero valencia')).toBe('do');
    expect(seoRuleIntent('Alquiler de trasteros baratos')).toBe('do');
    expect(seoRuleIntent('qué es un trastero')).toBe('know');
    expect(seoRuleIntent('trasteros cerca de mi')).toBe('visit');
    expect(seoRuleIntent('trasteros valencia')).toBeNull();
  });
  it('manual > SISTRIX > reglas, con su origen', () => {
    expect(seoResolveIntent({ manual: 'know', sistrix: 'do', query: 'precio' })).toEqual({
      value: 'know',
      source: 'manual',
    });
    expect(seoResolveIntent({ manual: null, sistrix: 'visit', query: 'precio' })).toEqual({
      value: 'visit',
      source: 'sistrix',
    });
    expect(seoResolveIntent({ manual: null, sistrix: null, query: 'precio' })).toEqual({
      value: 'do',
      source: 'rules',
    });
    expect(seoSistrixIntent({ know: 10, do: 5, visit: 80, website: 5 })).toBe('visit');
    expect(seoSistrixIntent({ know: null, do: null, visit: null, website: null })).toBeNull();
    expect(isCommercialIntent('visit')).toBe(true);
    expect(isCommercialIntent('know')).toBe(false);
  });
});

describe('scoreSeoOpportunity', () => {
  it('reparte el peso de lo que no se sabe y la puntuación cuadra con los puntos', () => {
    const r = scoreSeoOpportunity(base);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
    const unknown = r.factors.filter((f) => f.value === null).map((f) => f.key);
    expect(unknown).toEqual(
      expect.arrayContaining(['business', 'priority', 'trend', 'difficulty']),
    );
    expect(r.factors.find((f) => f.key === 'priority')!.points).toBe(0);
    const sum = r.factors.reduce((s, f) => s + f.points, 0);
    expect(Math.abs(sum - r.score)).toBeLessThan(1);
  });

  it('sin ningún dato: 0 puntos y confianza baja', () => {
    const r = scoreSeoOpportunity({
      ...base,
      impressions: null,
      clicks: null,
      position: null,
      ctr: null,
      hasGsc: false,
    });
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0.2);
  });

  it('más confianza con datos de Google que solo con SISTRIX', () => {
    const google = scoreSeoOpportunity(base);
    const onlySistrix = scoreSeoOpportunity({
      ...base,
      impressions: null,
      clicks: null,
      ctr: null,
      volume: 400,
      hasGsc: false,
      hasSistrix: true,
    });
    expect(google.confidence).toBeGreaterThan(onlySistrix.confidence);
    expect(onlySistrix.factors.find((f) => f.key === 'impressions')!.detail).toMatch(/SISTRIX/);
  });

  it('la dificultad resta, la intención comercial y la prioridad suman', () => {
    const plain = scoreSeoOpportunity(base).score;
    expect(scoreSeoOpportunity({ ...base, competition: 90 }).score).toBeLessThan(plain);
    expect(scoreSeoOpportunity({ ...base, intent: 'do', priority: 1 }).score).toBeGreaterThan(
      scoreSeoOpportunity({ ...base, intent: 'know', priority: 3 }).score,
    );
  });

  it('respeta los pesos del proyecto', () => {
    const onlyCtr = seoWeightsOf({
      impressions: 0,
      position: 0,
      ctrGap: 1,
      business: 0,
      priority: 0,
      trend: 0,
      difficulty: 0,
    });
    const good = scoreSeoOpportunity({ ...base, ctr: 0.2 }, onlyCtr);
    const bad = scoreSeoOpportunity({ ...base, ctr: 0.001 }, onlyCtr);
    expect(good.score).toBe(0);
    expect(bad.score).toBeGreaterThan(80);
  });
});

describe('pesos, umbrales y esquemas', () => {
  it('completa con los valores por defecto e ignora lo que se sale', () => {
    expect(seoWeightsOf({ impressions: 0.5, foo: 1 }).impressions).toBe(0.5);
    expect(seoWeightsOf({ impressions: 'x' }).impressions).toBe(SEO_DEFAULT_WEIGHTS.impressions);
    expect(seoThresholdsOf({ minImpressions: 10, periodDays: 3 })).toMatchObject({
      minImpressions: 10,
      periodDays: 28,
    });
  });
  it('pide motivo al descartar y algún peso positivo', () => {
    expect(UpdateSeoOpportunitySchema.safeParse({ status: 'dismissed' }).success).toBe(false);
    expect(
      UpdateSeoOpportunitySchema.safeParse({
        status: 'dismissed',
        dismissReason: 'Es otro negocio',
      }).success,
    ).toBe(true);
    expect(
      UpdateSeoOpportunitySettingsSchema.safeParse({
        weights: { impressions: 0, position: 0, ctrGap: 0, business: 0, priority: 0, trend: 0 },
      }).success,
    ).toBe(false);
  });
  it('miles sin depender del entorno', () => {
    expect(seoFmtInt(1234567)).toBe('1.234.567');
  });
});

describe('detectSeoOpportunities', () => {
  it('posiciones 4–10 y 11–20 con impresiones suficientes', () => {
    const list = detect({
      queries: [
        q('trasteros valencia', 400, 6),
        q('guardamuebles valencia', 300, 14),
        q('pocas impresiones', 10, 6),
        q('ya en el top', 900, 2, 200),
      ],
    });
    expect(types(list, 'trasteros valencia')).toEqual(['near_top3']);
    expect(types(list, 'guardamuebles valencia')).toEqual(['near_page1']);
    expect(types(list, 'pocas impresiones')).toEqual([]);
    expect(types(list, 'ya en el top')).toEqual([]);
    expect(list[0]!.reason).toMatch(/posición/);
    expect(list.every((o) => o.sources.includes('gsc'))).toBe(true);
  });

  it('comerciales en 21–50: la intención manual manda sobre las reglas', () => {
    const keywords: SeoOpportunityKeywordRow[] = [
      {
        keyword: 'trastero para estudiantes',
        inCatalog: true,
        intent: 'do',
        priority: 1,
        targetUrl: 'https://ejemplo.es/estudiantes',
        metrics: null,
      },
      {
        keyword: 'precio trastero mudanza',
        inCatalog: true,
        intent: 'know',
        priority: 2,
        targetUrl: null,
        metrics: null,
      },
    ];
    const list = detect({
      keywords,
      queries: [
        q('trastero para estudiantes', 40, 30),
        q('precio trastero mudanza', 40, 30),
        q('alquilar trastero barato', 40, 35),
        q('que es un trastero', 40, 35),
      ],
    });
    const student = list.find((o) => o.query === 'trastero para estudiantes')!;
    expect(student.type).toBe('commercial_deep');
    expect(student.targetUrl).toBe('https://ejemplo.es/estudiantes');
    expect(student.metrics.intent).toEqual({ value: 'do', source: 'manual' });
    expect(student.metrics.priority).toBe(1);
    expect(types(list, 'precio trastero mudanza')).toEqual([]);
    expect(types(list, 'alquilar trastero barato')).toEqual(['commercial_deep']);
    expect(types(list, 'que es un trastero')).toEqual([]);
  });

  it('mucho aparecer y poco clic', () => {
    const list = detect({ queries: [q('trasteros cerca de mi', 2000, 3, 5)] });
    const low = list.find((o) => o.type === 'low_ctr')!;
    expect(low.metrics.gsc!.expectedCtr).toBe(0.11);
    expect(low.factors.find((f) => f.key === 'ctrGap')!.value).toBeGreaterThan(0.9);
    expect(low.reason).toMatch(/CTR/);
  });

  it('suben y bajan solo con periodos comparables y mínimo de impresiones en los dos', () => {
    const queries = [
      q('boxes valencia', 100, 8, 5, { clicks: 1, impressions: 60, position: 18 }),
      q('trasteros mislata', 120, 12, 2, { clicks: 10, impressions: 140, position: 4 }),
      q('ruido', 100, 8, 5, { clicks: 0, impressions: 5, position: 30 }),
    ];
    const list = detect({ queries });
    expect(types(list, 'boxes valencia')).toContain('rising');
    expect(types(list, 'trasteros mislata')).toContain('falling');
    expect(types(list, 'ruido')).not.toContain('rising');
    const falling = list.find((o) => o.type === 'falling')!;
    expect(falling.metrics.gsc!.positionDiff).toBe(-8);
    expect(falling.factors.find((f) => f.key === 'trend')!.value).toBeGreaterThan(0);

    const notComparable = detect({ queries, period: { ...PERIOD, comparable: false } });
    expect(notComparable.some((o) => o.type === 'rising' || o.type === 'falling')).toBe(false);
    expect(
      notComparable
        .find((o) => o.query === 'boxes valencia')!
        .factors.find((f) => f.key === 'trend')!.value,
    ).toBeNull();
  });

  it('la marca va fuera salvo que caiga', () => {
    const list = detect({
      queries: [
        q('guardalo trasteros', 500, 5),
        q('guardalo valencia', 300, 9, 10, { clicks: 80, impressions: 320, position: 2 }),
      ],
    });
    expect(types(list, 'guardalo trasteros')).toEqual([]);
    expect(types(list, 'guardalo valencia')).toEqual(['falling']);
    expect(list.find((o) => o.query === 'guardalo valencia')!.metrics.brand).toBe(true);
  });

  it('impresiones reales frente al volumen de SISTRIX (§18.6)', () => {
    const metrics = (volume: number | null) => ({
      volume,
      competition: 20,
      cpc: 0.5,
      intent: 'visit' as const,
      origin: ORIGIN,
    });
    const keywords: SeoOpportunityKeywordRow[] = [
      {
        keyword: 'trasteros benimamet',
        inCatalog: true,
        intent: null,
        priority: 2,
        targetUrl: null,
        metrics: metrics(0),
      },
      {
        keyword: 'trasteros burjassot',
        inCatalog: true,
        intent: null,
        priority: 2,
        targetUrl: null,
        metrics: null,
      },
      {
        keyword: 'trasteros espana',
        inCatalog: true,
        intent: null,
        priority: 2,
        targetUrl: null,
        metrics: metrics(5000),
      },
      {
        keyword: 'guardamuebles espana',
        inCatalog: true,
        intent: null,
        priority: 2,
        targetUrl: null,
        metrics: metrics(8000),
      },
      {
        keyword: 'trasteros paterna',
        inCatalog: true,
        intent: null,
        priority: 2,
        targetUrl: null,
        metrics: metrics(30),
      },
    ];
    const queries = [
      q('trasteros benimamet', 60, 30),
      q('trasteros burjassot', 60, 30),
      q('trasteros espana', 20, 45),
      q('trasteros paterna', 90, 25),
    ];
    // Sin métricas de SISTRIX en el proyecto, «sin dato» no significa nada.
    const without = detect({ keywords, queries });
    expect(types(without, 'trasteros burjassot')).not.toContain('demand_gap');
    const list = detect({ keywords, queries, sistrixMetricsAvailable: true });
    const unseen = list.find((o) => o.query === 'trasteros benimamet' && o.type === 'demand_gap')!;
    expect(unseen.metrics.demandVariant).toBe('unseen_by_sistrix');
    expect(unseen.sources).toEqual(['gsc', 'sistrix']);
    expect(
      list.find((o) => o.query === 'trasteros burjassot' && o.type === 'demand_gap')!.metrics
        .demandVariant,
    ).toBe('unseen_by_sistrix');
    const lowShare = list.find((o) => o.query === 'trasteros espana' && o.type === 'demand_gap')!;
    expect(lowShare.metrics.demandVariant).toBe('low_share');
    expect(lowShare.metrics.impressionShare).toBe(0.004);
    // Volumen alto y ni apareces: también.
    const never = list.find((o) => o.query === 'guardamuebles espana')!;
    expect(never.metrics.gsc).toBeNull();
    expect(never.metrics.demandVariant).toBe('low_share');
    expect(
      list.find((o) => o.query === 'trasteros paterna' && o.type === 'demand_gap')!.metrics
        .demandVariant,
    ).toBe('above_volume');
  });

  it('las de SISTRIX se fusionan con una propia y si no, van aparte (solo SISTRIX)', () => {
    const list = detect({
      queries: [q('trasteros valencia precio', 400, 6)],
      sistrixOpportunities: [
        {
          keyword: 'Trasteros Valencia Precio',
          position: 7,
          url: 'https://ejemplo.es/',
          gain: 120,
          competition: 40,
          traffic: 900,
          origin: ORIGIN,
        },
        {
          keyword: 'mini almacen valencia',
          position: 15,
          url: null,
          gain: 80,
          competition: 30,
          traffic: 600,
          origin: ORIGIN,
        },
        {
          keyword: 'guardalo opiniones',
          position: 12,
          url: null,
          gain: 10,
          competition: 5,
          traffic: 50,
          origin: ORIGIN,
        },
      ],
    });
    const merged = list.filter((o) => o.query === 'trasteros valencia precio');
    expect(merged.map((o) => o.type)).toEqual(['near_top3']);
    expect(merged[0]!.sources).toEqual(['gsc', 'sistrix']);
    expect(merged[0]!.metrics.sistrix).toMatchObject({ gain: 120, volume: 900, competition: 40 });
    const only = list.find((o) => o.query === 'mini almacen valencia')!;
    expect(only.type).toBe('sistrix');
    expect(only.sources).toEqual(['sistrix']);
    expect(only.confidence).toBeLessThan(merged[0]!.confidence);
    expect(list.some((o) => o.query === 'guardalo opiniones')).toBe(false);
  });

  it('palabras de la competencia que tú no tienes', () => {
    const list = detect({
      queries: [q('trasteros valencia precio', 400, 6)],
      keywordGaps: [
        {
          keyword: 'almacenaje valencia',
          competitors: [
            { domain: 'b.es', position: 9, url: 'https://b.es/a' },
            { domain: 'a.es', position: 4, url: 'https://a.es/' },
          ],
          origin: ORIGIN,
        },
        {
          keyword: 'trasteros valencia precio',
          competitors: [{ domain: 'a.es', position: 2, url: '' }],
          origin: ORIGIN,
        },
        {
          keyword: 'muy abajo',
          competitors: [{ domain: 'a.es', position: 35, url: '' }],
          origin: ORIGIN,
        },
      ],
    });
    const gap = list.find((o) => o.type === 'keyword_gap')!;
    expect(gap.query).toBe('almacenaje valencia');
    expect(gap.metrics.competitors![0]!.domain).toBe('a.es');
    expect(gap.reason).toMatch(/a\.es sale en la posición 4 \(y 1 competidor más\)/);
    expect(list.filter((o) => o.type === 'keyword_gap')).toHaveLength(1);
  });

  it('sin datos no hay nada y la clave es estable', () => {
    expect(detect()).toEqual([]);
    const a = detect({ queries: [q('Trasteros  Valencia', 400, 6)] });
    const b = detect({ queries: [q('trasteros valencia', 800, 5)] });
    expect(a[0]!.key).toBe(b[0]!.key);
  });
});
