import { describe, expect, it } from 'vitest';

import { crossSeoPagePerformance, seoGa4Metrics, seoGa4PropertyId } from './ga4';
import {
  SEO_DEFAULT_WEIGHTS,
  scoreSeoOpportunity,
  seoEngagementFactorValue,
  type SeoOpportunityFactorsInput,
} from './opportunities';

const ga4 = (landing: string, sessions: number, engagedSessions: number) => ({
  landing,
  sessions,
  users: sessions,
  engagedSessions,
  durationSeconds: sessions * 60,
  pageViews: sessions * 2,
  keyEvents: 1,
});

describe('GA4 (PR 12)', () => {
  it('el número de la propiedad, con o sin «properties/»', () => {
    expect(seoGa4PropertyId('properties/123456789')).toBe('123456789');
    expect(seoGa4PropertyId(' 123456789 ')).toBe('123456789');
    expect(seoGa4PropertyId('G-ABC123')).toBeNull();
  });

  it('cifras: interacción, duración media y páginas por sesión; sin sesiones, null', () => {
    expect(
      seoGa4Metrics({
        sessions: 4,
        users: 3,
        engagedSessions: 1,
        durationSeconds: 200,
        pageViews: 10,
        keyEvents: 0.5,
      }),
    ).toEqual({
      sessions: 4,
      users: 3,
      engagedSessions: 1,
      engagementRate: 0.25,
      averageSessionDuration: 50,
      pagesPerSession: 2.5,
      keyEvents: 0.5,
    });
    expect(
      seoGa4Metrics({
        sessions: 0,
        users: 0,
        engagedSessions: 0,
        durationSeconds: 0,
        pageViews: 0,
        keyEvents: 0,
      }).engagementRate,
    ).toBeNull();
  });

  it('cruza Search Console, GA4 y las conversiones por página; lo que falta, null (nunca 0 inventado)', () => {
    const rows = crossSeoPagePerformance({
      gsc: [
        { landing: '/precios', clicks: 30, impressions: 600, weightedPosition: 600 * 4 },
        { landing: '/precios', clicks: 10, impressions: 400, weightedPosition: 400 * 9 },
        { landing: '/blog/solo-google', clicks: 5, impressions: 50, weightedPosition: 50 * 12 },
      ],
      ga4: [ga4('/precios', 100, 20), ga4('/', 80, 60)],
      conversions: [
        { landing: '/precios', conversions: 4 },
        { landing: '', conversions: 2 },
      ],
    });
    const precios = rows.find((r) => r.landing === '/precios')!;
    expect(precios.gsc).toEqual({ clicks: 40, impressions: 1000, ctr: 0.04, position: 6 });
    expect(precios.ga4?.sessions).toBe(100);
    expect(precios.ga4?.engagementRate).toBe(0.2);
    expect(precios.conversions).toBe(4);
    expect(precios.conversionsPerSession).toBe(0.04);
    const home = rows.find((r) => r.landing === '/')!;
    expect(home.gsc).toBeNull();
    const blog = rows.find((r) => r.landing === '/blog/solo-google')!;
    expect(blog.ga4).toBeNull();
    expect(blog.conversionsPerSession).toBeNull();
    // Por clics: la de más clics primero.
    expect(rows[0]!.landing).toBe('/precios');
  });

  it('ordenar por «mucho tráfico y poca interacción» pone primero esa página', () => {
    const rows = crossSeoPagePerformance({
      gsc: [],
      ga4: [ga4('/', 80, 70), ga4('/precios', 100, 10)],
      conversions: [],
      sort: 'engagement',
    });
    expect(rows.map((r) => r.landing)).toEqual(['/precios', '/']);
  });
});

describe('Factor «Mucho tráfico y poca interacción»', () => {
  const base: SeoOpportunityFactorsInput = {
    impressions: 700,
    clicks: 20,
    volume: null,
    gain: null,
    position: 9,
    ctr: 0.03,
    intent: 'do',
    priority: 1,
    positionDiff: null,
    impressionsPct: null,
    competition: null,
    hasGsc: true,
    hasSistrix: false,
    comparable: false,
  };

  it('solo entra con sesiones suficientes; sin dato la puntuación no cambia', () => {
    expect(seoEngagementFactorValue({ sessions: 10, engagedSessions: 0 })).toBeNull();
    expect(seoEngagementFactorValue({ sessions: 100, engagedSessions: 70 })).toEqual({
      value: 0,
      rate: 0.7,
    });
    expect(seoEngagementFactorValue({ sessions: 100, engagedSessions: 15 })?.value).toBeCloseTo(
      0.75,
    );
    const plain = scoreSeoOpportunity(base, SEO_DEFAULT_WEIGHTS);
    const few = scoreSeoOpportunity(
      { ...base, pageEngagement: { sessions: 10, engagedSessions: 0 } },
      SEO_DEFAULT_WEIGHTS,
    );
    expect(few.score).toBe(plain.score);
    expect(few.factors.some((f) => f.key === 'engagement')).toBe(false);
  });

  it('con mucho tráfico y poca interacción el factor sube la puntuación y se explica', () => {
    const plain = scoreSeoOpportunity(base, SEO_DEFAULT_WEIGHTS);
    const low = scoreSeoOpportunity(
      { ...base, pageEngagement: { sessions: 300, engagedSessions: 30 } },
      SEO_DEFAULT_WEIGHTS,
    );
    const f = low.factors.find((x) => x.key === 'engagement')!;
    expect(f.value).toBeCloseTo(0.833, 2);
    expect(f.detail).toContain('300 sesiones');
    expect(low.score).toBeGreaterThanOrEqual(plain.score);
  });
});
