import { describe, expect, it } from 'vitest';

import {
  SEO_DEFAULT_CANNIBALIZATION_THRESHOLDS,
  SEO_DEFAULT_INDEX_RULES,
  UpdateSeoDiagnosticSettingsSchema,
  analyzeSeoCannibalization,
  detectSeoIndexFindings,
  isSeoHomeUrl,
  matchSeoIndexRule,
  mergeSeoPages,
  normalizeSeoUrl,
  parseSeoIntent,
  parseSeoPriority,
  planSeoKeywordImport,
  seoDailyWinners,
  seoDiagnosticSettingsOf,
  seoGroupTrackedKeywords,
  seoIndexRuleCategory,
  seoIndexRuleMatches,
  seoPageChanges,
  seoTargetStatus,
  type SeoDailyPageRow,
  type SeoKeywordImportExisting,
} from './diagnostics';

const T = { ...SEO_DEFAULT_CANNIBALIZATION_THRESHOLDS };
const BASE = 'https://ejemplo.es';

/** Días de octubre (1 = 2026-10-01). */
const d = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;

describe('normalización de URL', () => {
  it('junta protocolo, www, barra final, mayúsculas y parámetros de seguimiento', () => {
    const key = normalizeSeoUrl('https://ejemplo.es/precios');
    expect(normalizeSeoUrl('http://www.ejemplo.es/Precios/')).toBe(key);
    expect(normalizeSeoUrl('https://ejemplo.es/precios?utm_source=x&gclid=1')).toBe(key);
    expect(normalizeSeoUrl('https://ejemplo.es:443/precios#tarifas')).toBe(key);
    expect(key).toBe('ejemplo.es/precios');
  });

  it('conserva y ordena los parámetros que sí cambian la página', () => {
    expect(normalizeSeoUrl('https://ejemplo.es/buscar?b=2&a=1&utm_medium=x')).toBe(
      'ejemplo.es/buscar?a=1&b=2',
    );
    expect(normalizeSeoUrl('https://ejemplo.es/buscar?a=1')).not.toBe(
      normalizeSeoUrl('https://ejemplo.es/buscar?a=2'),
    );
  });

  it('reconoce la portada', () => {
    expect(isSeoHomeUrl('https://www.ejemplo.es/')).toBe(true);
    expect(isSeoHomeUrl('https://ejemplo.es?utm_source=x')).toBe(true);
    expect(isSeoHomeUrl('https://ejemplo.es/precios')).toBe(false);
  });

  it('suma las variantes en una sola página con la posición ponderada', () => {
    const merged = mergeSeoPages([
      { page: `${BASE}/precios`, clicks: 4, impressions: 100, position: 4 },
      { page: 'http://www.ejemplo.es/precios/', clicks: 1, impressions: 300, position: 8 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ clicks: 5, impressions: 400, position: 7 });
    expect(merged[0]!.page).toBe('http://www.ejemplo.es/precios/');
  });
});

describe('URL objetivo frente a la que enseña Google', () => {
  const pages = (a: number, b: number) => [
    { page: `${BASE}/precios`, clicks: Math.round(a / 10), impressions: a, position: 5 },
    { page: `${BASE}/`, clicks: Math.round(b / 10), impressions: b, position: 9 },
  ];

  it('ok: la URL objetivo se lleva la mayoría (aunque venga con www o barra)', () => {
    const r = seoTargetStatus({
      targetUrl: 'http://www.ejemplo.es/precios/',
      pages: pages(90, 10),
    });
    expect(r.status).toBe('ok');
    expect(r.targetShare).toBe(0.9);
  });

  it('other_page: Google enseña otra y la tuya apenas sale', () => {
    const r = seoTargetStatus({ targetUrl: `${BASE}/contacto`, pages: pages(90, 10) });
    expect(r.status).toBe('other_page');
    expect(r.topPage).toBe(`${BASE}/precios`);
  });

  it('split: se reparten', () => {
    expect(seoTargetStatus({ targetUrl: `${BASE}/precios`, pages: pages(55, 45) }).status).toBe(
      'split',
    );
    expect(seoTargetStatus({ targetUrl: `${BASE}/`, pages: pages(60, 40) }).status).toBe('split');
  });

  it('none: sin impresiones; y sin URL objetivo se propone la de más clics', () => {
    expect(seoTargetStatus({ targetUrl: `${BASE}/precios`, pages: [] }).status).toBe('none');
    const r = seoTargetStatus({
      targetUrl: null,
      pages: [
        { page: `${BASE}/a`, clicks: 1, impressions: 500, position: 9 },
        { page: `${BASE}/b`, clicks: 12, impressions: 200, position: 3 },
      ],
    });
    expect(r.status).toBe('no_target');
    expect(r.suggestedUrl).toBe(`${BASE}/b`);
  });
});

describe('página ganadora de cada día', () => {
  it('marca los días en que cambia (sin contar variantes)', () => {
    const rows: SeoDailyPageRow[] = [
      { date: d(1), page: `${BASE}/a`, clicks: 1, impressions: 10 },
      { date: d(1), page: `${BASE}/b`, clicks: 0, impressions: 5 },
      { date: d(2), page: 'http://www.ejemplo.es/a/', clicks: 0, impressions: 7 },
      { date: d(3), page: `${BASE}/b`, clicks: 2, impressions: 9 },
      { date: d(3), page: `${BASE}/a`, clicks: 0, impressions: 3 },
    ];
    const winners = seoDailyWinners(rows);
    expect(winners.map((w) => w.date)).toEqual([d(1), d(2), d(3)]);
    expect(seoPageChanges(winners)).toEqual([
      { date: d(3), from: 'http://www.ejemplo.es/a/', to: `${BASE}/b` },
    ]);
  });
});

describe('canibalización', () => {
  /** Días alternos entre dos páginas (o siempre la primera). */
  const daily = (days: number, alternate: boolean, a = `${BASE}/a`, b = `${BASE}/b`) => {
    const rows: SeoDailyPageRow[] = [];
    for (let k = 1; k <= days; k++) {
      const aWins = !alternate || k % 2 === 1;
      rows.push({ date: d(k), page: a, clicks: 1, impressions: aWins ? 10 : 4 });
      rows.push({ date: d(k), page: b, clicks: 1, impressions: aWins ? 4 : 10 });
    }
    return rows;
  };

  it('dos páginas que se alternan: probable conflicto de gravedad alta', () => {
    const c = analyzeSeoCannibalization({
      query: 'trasteros valencia',
      brandTerms: [],
      pages: [
        { page: `${BASE}/a`, clicks: 10, impressions: 120, position: 6 },
        { page: `${BASE}/b`, clicks: 6, impressions: 100, position: 9 },
      ],
      daily: daily(10, true),
      targetUrl: null,
      thresholds: T,
    });
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('conflict');
    expect(c!.severity).toBe('high');
    expect(c!.switches).toBeGreaterThanOrEqual(3);
    expect(c!.suggestedUrl).toBe(`${BASE}/a`);
    expect(c!.reason).toContain('ha cambiado');
    expect(c!.action).toContain('Consolidar');
    expect(c!.lastDataDate).toBe(d(10));
  });

  it('dos páginas que salen a la vez cada día no son una alternancia: no hay conflicto', () => {
    // Las dos en la primera página, casi empatadas: gana una u otra por una impresión.
    const rows: SeoDailyPageRow[] = [];
    for (let k = 1; k <= 14; k++) {
      const aWins = k % 2 === 1;
      rows.push({ date: d(k), page: `${BASE}/a`, clicks: 1, impressions: aWins ? 5 : 4 });
      rows.push({ date: d(k), page: `${BASE}/b`, clicks: 1, impressions: aWins ? 4 : 5 });
    }
    const c = analyzeSeoCannibalization({
      query: 'trasteros valencia',
      brandTerms: [],
      pages: [
        { page: `${BASE}/a`, clicks: 14, impressions: 63, position: 6.2 },
        { page: `${BASE}/b`, clicks: 14, impressions: 63, position: 4.1 },
      ],
      daily: rows,
      targetUrl: null,
      thresholds: T,
    });
    expect(c).not.toBeNull();
    expect(c!.kind).toBe('coexistence');
    expect(c!.severity).toBe('low');
    expect(c!.switches).toBe(0);
  });

  it('dos páginas que se reparten sin alternarse: reparto (no conflicto)', () => {
    const c = analyzeSeoCannibalization({
      query: 'guardamuebles valencia',
      brandTerms: [],
      pages: [
        { page: `${BASE}/a`, clicks: 10, impressions: 120, position: 14 },
        { page: `${BASE}/b`, clicks: 6, impressions: 100, position: 18 },
      ],
      daily: daily(10, false),
      targetUrl: null,
      thresholds: T,
    });
    expect(c!.kind).toBe('split');
    expect(c!.severity).toBe('medium');
  });

  it('caso esperado: la URL objetivo y la portada con pocas impresiones, gravedad baja', () => {
    const c = analyzeSeoCannibalization({
      query: 'trasteros mislata',
      brandTerms: [],
      pages: [
        { page: `${BASE}/mislata`, clicks: 20, impressions: 300, position: 3 },
        { page: `${BASE}/`, clicks: 1, impressions: 40, position: 12 },
      ],
      daily: daily(10, true, `${BASE}/mislata`, `${BASE}/`),
      targetUrl: `${BASE}/mislata/`,
      thresholds: T,
    });
    expect(c!.expected).toBe(true);
    expect(c!.severity).toBe('low');
    expect(c!.pages.find((p) => p.isTarget)?.page).toBe(`${BASE}/mislata`);
    expect(c!.pages.find((p) => p.isHome)).toBeDefined();
  });

  it('excluye la marca y no cuenta variantes de la misma URL como dos páginas', () => {
    const pages = [
      { page: `${BASE}/a`, clicks: 10, impressions: 120, position: 6 },
      { page: 'http://www.ejemplo.es/a/', clicks: 6, impressions: 100, position: 9 },
    ];
    expect(
      analyzeSeoCannibalization({
        query: 'guardalo trasteros',
        brandTerms: ['guardalo'],
        pages: [...pages, { page: `${BASE}/b`, clicks: 3, impressions: 90, position: 9 }],
        daily: [],
        targetUrl: null,
        thresholds: T,
      }),
    ).toBeNull();
    expect(
      analyzeSeoCannibalization({
        query: 'trasteros',
        brandTerms: [],
        pages,
        daily: [],
        targetUrl: null,
        thresholds: T,
      }),
    ).toBeNull();
  });

  it('una segunda página por debajo del umbral no cuenta', () => {
    expect(
      analyzeSeoCannibalization({
        query: 'trasteros baratos',
        brandTerms: [],
        pages: [
          { page: `${BASE}/a`, clicks: 10, impressions: 500, position: 6 },
          { page: `${BASE}/b`, clicks: 0, impressions: 20, position: 30 },
        ],
        daily: [],
        targetUrl: null,
        thresholds: T,
      }),
    ).toBeNull();
  });
});

describe('reglas de indexación', () => {
  it('trae las rutas que la web marca como no indexables', () => {
    expect(SEO_DEFAULT_INDEX_RULES).toContain('/portal');
    expect(SEO_DEFAULT_INDEX_RULES).toContain('/login');
    expect(SEO_DEFAULT_INDEX_RULES).toContain('/api/');
    expect(seoIndexRuleCategory('/login')).toBe('login');
    expect(seoIndexRuleCategory('/portal')).toBe('private');
    expect(seoIndexRuleCategory('?utm_')).toBe('params');
    expect(seoIndexRuleCategory('/mi-regla')).toBe('custom');
  });

  it('casa por ruta, parámetro y comodín', () => {
    expect(seoIndexRuleMatches('/pay', `${BASE}/pay/abc`)).toBe(true);
    expect(seoIndexRuleMatches('/pay', `${BASE}/payments`)).toBe(false);
    expect(seoIndexRuleMatches('?token=', `${BASE}/x?token=abc`)).toBe(true);
    expect(seoIndexRuleMatches('?token=', `${BASE}/x?tokens=abc`)).toBe(false);
    expect(seoIndexRuleMatches('?utm_', `${BASE}/x?utm_source=a`)).toBe(true);
    expect(seoIndexRuleMatches('?', `${BASE}/x`)).toBe(false);
    expect(seoIndexRuleMatches('*demo*', `${BASE}/s/demo-trasteros`)).toBe(true);
    expect(matchSeoIndexRule(`${BASE}/login`, SEO_DEFAULT_INDEX_RULES)).toBe('/login');
    expect(matchSeoIndexRule(`${BASE}/precios`, SEO_DEFAULT_INDEX_RULES)).toBeNull();
  });

  it('hallazgos: reglas, variantes duplicadas y dominio que debería redirigir', () => {
    const row = (page: string, impressions: number) => ({
      page,
      clicks: 1,
      impressions,
      firstDate: d(1),
      lastDate: d(20),
    });
    const found = detectSeoIndexFindings({
      pages: [
        row(`${BASE}/portal/facturas`, 30),
        row(`${BASE}/precios`, 300),
        row('http://www.ejemplo.es/precios/', 12),
        row(`${BASE}/blog`, 50),
      ],
      rules: SEO_DEFAULT_INDEX_RULES,
      redirectDomain: false,
    });
    expect(found.map((f) => [f.url, f.category])).toEqual([
      [`${BASE}/portal/facturas`, 'private'],
      ['http://www.ejemplo.es/precios/', 'duplicate'],
    ]);
    expect(found[0]!.reason).toContain('Aparece en el rendimiento de Search Console');
    const redirect = detectSeoIndexFindings({
      pages: [row(`${BASE}/precios`, 5)],
      rules: [],
      redirectDomain: true,
    });
    expect(redirect[0]!.category).toBe('redirect_domain');
  });

  it('ajustes: reglas propias o las de por defecto', () => {
    expect(seoDiagnosticSettingsOf({}).customIndexRules).toBe(false);
    const s = seoDiagnosticSettingsOf({
      indexRules: ['/x'],
      cannibalization: { periodDays: 90, minSecondShare: 9 },
    });
    expect(s.indexRules).toEqual(['/x']);
    expect(s.customIndexRules).toBe(true);
    expect(s.cannibalization.periodDays).toBe(90);
    expect(s.cannibalization.minSecondShare).toBe(T.minSecondShare);
    expect(UpdateSeoDiagnosticSettingsSchema.safeParse({ indexRules: ['/a', '/a'] }).data).toEqual({
      indexRules: ['/a'],
    });
  });
});

describe('alta de palabras desde CSV', () => {
  const existing = new Map<string, SeoKeywordImportExisting>([
    [
      'trasteros valencia',
      {
        groupName: null,
        intent: null,
        targetUrl: 'https://e.es/v',
        notes: 'mía',
        strategyLocked: false,
      },
    ],
    [
      'guardamuebles',
      { groupName: null, intent: null, targetUrl: null, notes: null, strategyLocked: true },
    ],
  ]);

  it('nuevas, se completan sin pisar, fijadas sin tocar y errores', () => {
    const plan = planSeoKeywordImport({
      existing,
      rows: [
        {
          line: 2,
          keyword: 'Trasteros  Valencia',
          groupName: 'Valencia',
          intent: 'comercial',
          targetUrl: 'https://e.es/otra',
          notes: 'otra',
        },
        { line: 3, keyword: 'guardamuebles', groupName: 'G', intent: 'local' },
        { line: 4, keyword: 'trasteros mislata', priority: 'alta', intent: 'Informativa' },
        { line: 5, keyword: 'x' },
        { line: 6, keyword: 'trasteros mislata' },
        { line: 7, keyword: 'otra', intent: 'rara' },
        { line: 8, keyword: 'otra mas', targetUrl: 'ftp://x' },
        { line: 9, keyword: 'trasteros valencia' },
      ],
    });
    const byLine = new Map(plan.items.map((i) => [i.line, i]));
    expect(byLine.get(2)).toMatchObject({ action: 'update', changes: ['groupName', 'intent'] });
    expect(byLine.get(3)!.action).toBe('locked');
    expect(byLine.get(4)).toMatchObject({
      action: 'create',
      data: { priority: 1, intent: 'know' },
    });
    expect(byLine.get(5)!.action).toBe('error');
    expect(byLine.get(6)!.error).toContain('repetida');
    expect(byLine.get(7)!.error).toContain('intención');
    expect(byLine.get(8)!.error).toContain('URL');
    expect(byLine.get(9)!.error).toContain('repetida');
    expect(plan.counts).toEqual({ create: 1, update: 1, unchanged: 0, locked: 1, error: 5 });
  });

  it('entiende intención y prioridad en castellano o inglés', () => {
    expect(parseSeoIntent('Transaccional')).toBe('do');
    expect(parseSeoIntent('navegación')).toBe('website');
    expect(parseSeoIntent('')).toBeNull();
    expect(parseSeoPriority('Baja')).toBe(3);
    expect(parseSeoPriority('7')).toBe('invalid');
  });
});

describe('palabras seguidas por intención o grupo', () => {
  it('suma clics e impresiones y pondera la posición', () => {
    const groups = seoGroupTrackedKeywords(
      [
        { intent: 'do', groupName: 'A', clicks: 10, impressions: 100, position: 4 },
        { intent: 'do', groupName: null, clicks: 0, impressions: 300, position: 8 },
        { intent: null, groupName: 'A', clicks: 1, impressions: 0, position: null },
      ],
      'intent',
      { intent: { do: 'Contratar' }, none: 'Sin intención' },
    );
    expect(groups[0]).toMatchObject({
      label: 'Contratar',
      keywords: 2,
      clicks: 10,
      impressions: 400,
      position: 7,
    });
    expect(groups[1]!.label).toBe('Sin intención');
  });
});
