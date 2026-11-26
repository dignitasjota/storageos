import { describe, expect, it } from 'vitest';

import {
  SEO_INSPECTION_GOOGLE_DAILY_LIMIT,
  seoAbsoluteUrl,
  seoCanonicalMismatch,
  seoCwvRating,
  seoIndexStatusLabel,
  seoInspectionAlerts,
  seoInspectionIndexed,
  seoInspectionQuota,
  seoNextQuotaReset,
  seoNotIndexedReason,
  seoPageSpeedAlerts,
  seoQuotaDay,
  seoScoreRating,
  seoTechnicalSettingsOf,
  seoInspectionUrlKey,
  selectSeoInspectionBatch,
  selectSeoPageSpeedUrls,
} from './inspection';

describe('cuota diaria de la inspección', () => {
  it('cuenta el día en la hora del Pacífico', () => {
    // 07:30 UTC del 26 de noviembre = 23:30 del 25 en California (invierno, UTC-8).
    expect(seoQuotaDay(new Date('2026-11-26T07:30:00Z'))).toBe('2026-11-25');
    expect(seoQuotaDay(new Date('2026-11-26T08:30:00Z'))).toBe('2026-11-26');
  });

  it('se reinicia a medianoche del Pacífico, también con horario de verano', () => {
    expect(seoNextQuotaReset(new Date('2026-11-26T10:00:00Z')).toISOString()).toBe(
      '2026-11-27T08:00:00.000Z',
    );
    // Julio: UTC-7.
    expect(seoNextQuotaReset(new Date('2026-07-10T12:00:00Z')).toISOString()).toBe(
      '2026-07-11T07:00:00.000Z',
    );
  });

  it('lo que queda es lo menor entre el tope del proyecto y lo que deja Google', () => {
    expect(seoInspectionQuota({ usedByProject: 37, usedByProperty: 37, cap: 200 }).remaining).toBe(
      163,
    );
    expect(
      seoInspectionQuota({ usedByProject: 10, usedByProperty: 1995, cap: 1000 }).remaining,
    ).toBe(SEO_INSPECTION_GOOGLE_DAILY_LIMIT - 1995);
    expect(
      seoInspectionQuota({ usedByProject: 250, usedByProperty: 250, cap: 200 }).remaining,
    ).toBe(0);
  });

  it('ajustes por defecto según el ámbito y valores acotados', () => {
    expect(seoTechnicalSettingsOf(null, 'tenant').inspectionDailyCap).toBe(200);
    expect(seoTechnicalSettingsOf({}, 'platform').inspectionDailyCap).toBe(1000);
    const s = seoTechnicalSettingsOf(
      { inspectionDailyCap: 5000, inspectionBatchEnabled: true, pagespeedMaxUrls: 0 },
      'tenant',
    );
    expect(s.inspectionDailyCap).toBe(1000);
    expect(s.inspectionBatchEnabled).toBe(true);
    expect(s.pagespeedMaxUrls).toBe(1);
  });
});

describe('lote programado', () => {
  const now = new Date('2026-11-26T10:00:00Z');
  const base = {
    pending: new Set<string>(),
    now,
    reinspectDays: 14,
    max: 10,
    remaining: 100,
  };

  it('prioriza las URL objetivo importantes, sin repetir ni volver antes de N días', () => {
    const out = selectSeoInspectionBatch({
      ...base,
      candidates: [
        { url: 'https://ejemplo.es/blog', reason: 'top_clicks' },
        { url: 'https://ejemplo.es/privado', reason: 'index_finding' },
        { url: 'https://www.ejemplo.es/Precios/', reason: 'top_clicks' },
        { url: 'https://ejemplo.es/precios', reason: 'target_high' },
        { url: 'https://ejemplo.es/reciente', reason: 'target_high' },
        { url: '/relativa', reason: 'target_high' },
      ],
      lastInspected: new Map([
        ['ejemplo.es/reciente', '2026-11-20T00:00:00Z'],
        ['ejemplo.es/blog', '2026-10-01T00:00:00Z'],
      ]),
    });
    expect(out.map((o) => `${o.reason}:${o.urlKey}`)).toEqual([
      'target_high:ejemplo.es/precios',
      'index_finding:ejemplo.es/privado',
      'top_clicks:ejemplo.es/blog',
    ]);
  });

  it('no pasa del tope ni de la cuota, y salta lo que ya espera', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      url: `https://ejemplo.es/p${i}`,
      reason: 'top_clicks' as const,
    }));
    expect(
      selectSeoInspectionBatch({ ...base, candidates, lastInspected: new Map(), remaining: 3 }),
    ).toHaveLength(3);
    expect(
      selectSeoInspectionBatch({ ...base, candidates, lastInspected: new Map(), max: 5 }),
    ).toHaveLength(5);
    expect(
      selectSeoInspectionBatch({
        ...base,
        candidates: candidates.slice(0, 2),
        lastInspected: new Map(),
        pending: new Set(['ejemplo.es/p0']),
      }).map((o) => o.urlKey),
    ).toEqual(['ejemplo.es/p1']);
    expect(
      selectSeoInspectionBatch({ ...base, candidates, lastInspected: new Map(), remaining: 0 }),
    ).toEqual([]);
  });
});

describe('veredicto de Google', () => {
  it('indexada solo con PASS', () => {
    expect(seoInspectionIndexed('PASS')).toBe(true);
    expect(seoInspectionIndexed('NEUTRAL')).toBe(false);
    expect(seoInspectionIndexed('FAIL')).toBe(false);
    expect(seoInspectionIndexed('VERDICT_UNSPECIFIED')).toBeNull();
    expect(seoInspectionIndexed(null)).toBeNull();
  });

  it('el motivo más concreto primero', () => {
    const base = {
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      pageFetchState: 'SUCCESSFUL',
      coverageState: 'Rastreada: actualmente sin indexar',
      canonicalMismatch: false,
    };
    expect(seoNotIndexedReason({ ...base, robotsTxtState: 'DISALLOWED' })).toBe(
      'Bloqueada en robots.txt',
    );
    expect(seoNotIndexedReason({ ...base, indexingState: 'BLOCKED_BY_META_TAG' })).toContain(
      'noindex',
    );
    expect(seoNotIndexedReason({ ...base, pageFetchState: 'NOT_FOUND' })).toBe('No existe (404)');
    expect(seoNotIndexedReason({ ...base, canonicalMismatch: true })).toContain('canónica');
    expect(seoNotIndexedReason(base)).toBe('Rastreada: actualmente sin indexar');
  });

  it('canónica distinta de la declarada (o de la propia URL)', () => {
    expect(
      seoCanonicalMismatch({
        url: 'https://ejemplo.es/a',
        googleCanonical: 'https://www.ejemplo.es/a/',
        userCanonical: 'https://ejemplo.es/a',
      }),
    ).toBe(false);
    expect(
      seoCanonicalMismatch({
        url: 'https://ejemplo.es/a',
        googleCanonical: 'https://ejemplo.es/',
        userCanonical: 'https://ejemplo.es/a',
      }),
    ).toBe(true);
    expect(
      seoCanonicalMismatch({
        url: 'https://ejemplo.es/a?x=1',
        googleCanonical: 'https://ejemplo.es/a',
        userCanonical: null,
      }),
    ).toBe(true);
    expect(
      seoCanonicalMismatch({
        url: 'https://ejemplo.es/a',
        googleCanonical: null,
        userCanonical: null,
      }),
    ).toBe(false);
  });

  it('etiqueta de Indexación con la fecha', () => {
    expect(
      seoIndexStatusLabel({ indexed: true, inspectedAt: '2026-11-25T10:00:00Z', reason: null }),
    ).toBe('Indexación confirmada (25/11/2026)');
    expect(
      seoIndexStatusLabel({
        indexed: false,
        inspectedAt: '2026-11-25T10:00:00Z',
        reason: 'Tiene «noindex»',
      }),
    ).toContain('Google dice que no está indexada (Tiene «noindex»');
  });

  it('URL relativas con el dominio del proyecto', () => {
    expect(seoAbsoluteUrl('/precios', 'ejemplo.es')).toBe('https://ejemplo.es/precios');
    expect(seoInspectionUrlKey('/Precios/', 'www.ejemplo.es')).toBe('ejemplo.es/precios');
    expect(seoAbsoluteUrl('otra.es/a', 'ejemplo.es')).toBe('https://otra.es/a');
  });
});

describe('alertas nuevas', () => {
  const now = new Date('2026-11-26T10:00:00Z');
  const targets = new Map([['ejemplo.es/precios', { keywords: ['trasteros'], high: true }]]);
  const insp = {
    url: 'https://ejemplo.es/precios',
    urlKey: 'ejemplo.es/precios',
    inspectedAt: '2026-11-25T10:00:00Z',
    indexed: false as boolean | null,
    reason: 'Tiene «noindex»',
    canonicalMismatch: false,
    googleCanonical: null as string | null,
  };

  it('URL objetivo no indexada y canónica distinta (con clave estable)', () => {
    const a = seoInspectionAlerts({ inspections: [insp], targets, now });
    expect(a.map((x) => [x.type, x.key, x.severity])).toEqual([
      ['target_not_indexed', 'target_not_indexed|ejemplo.es/precios', 'high'],
    ]);
    const b = seoInspectionAlerts({
      inspections: [
        { ...insp, indexed: true, canonicalMismatch: true, googleCanonical: 'https://ejemplo.es/' },
      ],
      targets: new Map(),
      now,
    });
    expect(b.map((x) => [x.type, x.severity])).toEqual([['canonical_mismatch', 'medium']]);
  });

  it('una URL que no es objetivo, indexada o con inspección vieja no avisa', () => {
    expect(seoInspectionAlerts({ inspections: [insp], targets: new Map(), now })).toEqual([]);
    expect(
      seoInspectionAlerts({ inspections: [{ ...insp, indexed: true }], targets, now }),
    ).toEqual([]);
    expect(
      seoInspectionAlerts({
        inspections: [{ ...insp, inspectedAt: '2026-09-01T00:00:00Z' }],
        targets,
        now,
      }),
    ).toEqual([]);
  });

  it('velocidad: lenta en campo y caída de la puntuación', () => {
    const latest = {
      performance: 40,
      fieldOverall: 'SLOW' as const,
      analyzedAt: '2026-11-25T00:00:00Z',
    };
    const a = seoPageSpeedAlerts({
      url: 'https://ejemplo.es/',
      urlKey: 'ejemplo.es/',
      strategy: 'mobile',
      latest,
      previous: { performance: 80 },
      dropPoints: 15,
    });
    expect(a.map((x) => [x.type, x.severity])).toEqual([
      ['pagespeed_slow', 'high'],
      ['pagespeed_drop', 'high'],
    ]);
    expect(
      seoPageSpeedAlerts({
        url: 'https://ejemplo.es/',
        urlKey: 'ejemplo.es/',
        strategy: 'desktop',
        latest: { ...latest, fieldOverall: 'FAST', performance: 70 },
        previous: { performance: 80 },
        dropPoints: 15,
      }),
    ).toEqual([]);
  });
});

describe('PageSpeed', () => {
  it('portada primero, sin repetir y hasta el tope', () => {
    expect(
      selectSeoPageSpeedUrls({
        home: 'https://ejemplo.es/',
        targets: ['https://ejemplo.es/precios', '/relativa'],
        topPages: [
          'https://www.ejemplo.es/precios/',
          'https://ejemplo.es/blog',
          'https://ejemplo.es/x',
        ],
        max: 3,
      }),
    ).toEqual(['https://ejemplo.es/', 'https://ejemplo.es/precios', 'https://ejemplo.es/blog']);
  });

  it('umbrales de las Core Web Vitals y de la puntuación', () => {
    expect(seoCwvRating('lcp', 2400)).toBe('good');
    expect(seoCwvRating('lcp', 3000)).toBe('needs_improvement');
    expect(seoCwvRating('inp', 600)).toBe('poor');
    expect(seoCwvRating('cls', 0.05)).toBe('good');
    expect(seoCwvRating('cls', null)).toBeNull();
    expect(seoScoreRating(92)).toBe('good');
    expect(seoScoreRating(49)).toBe('poor');
  });
});
