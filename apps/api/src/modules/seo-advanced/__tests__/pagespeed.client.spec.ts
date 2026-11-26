import { PageSpeedClient, PageSpeedError, parsePageSpeed } from '../technical/pagespeed.client';

const config = (key?: string) =>
  ({ get: (k: string) => (k === 'PAGESPEED_API_KEY' ? key : undefined) }) as never;

/** Respuesta de PageSpeed con las cuatro categorías, auditorías y CrUX opcional. */
function response(opts: { field?: boolean; originOnly?: boolean } = {}) {
  const exp = (overall: string) => ({
    overall_category: overall,
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: 'AVERAGE' },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST' },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: 'AVERAGE' },
    },
  });
  return {
    id: 'https://a.es/',
    analysisUTCTimestamp: '2026-11-25T10:00:00.000Z',
    ...(opts.field ? { loadingExperience: exp('AVERAGE') } : {}),
    ...(opts.originOnly ? { loadingExperience: { ...exp('SLOW'), origin_fallback: true } } : {}),
    ...(opts.field || opts.originOnly ? { originLoadingExperience: exp('SLOW') } : {}),
    lighthouseResult: {
      finalUrl: 'https://a.es/',
      categories: {
        performance: { score: 0.63 },
        seo: { score: 0.92 },
        accessibility: { score: 0.881 },
        'best-practices': { score: 1 },
      },
      audits: {
        'largest-contentful-paint': { score: 0.4, numericValue: 3456.7 },
        'cumulative-layout-shift': { score: 0.9, numericValue: 0.04321 },
        'total-blocking-time': { score: 0.6, numericValue: 310 },
        'first-contentful-paint': { score: 0.8, numericValue: 1500 },
        'speed-index': { score: 0.7, numericValue: 3900 },
        interactive: { score: 0.5, numericValue: 6000 },
        'uses-optimized-images': {
          title: 'Codifica las imágenes de forma eficiente',
          score: 0.3,
          scoreDisplayMode: 'metricSavings',
          displayValue: 'Ahorro de 120 KiB',
          details: { type: 'opportunity', overallSavingsMs: 900 },
        },
        'render-blocking-resources': {
          title: 'Elimina los recursos que bloquean el renderizado',
          score: 0.5,
          scoreDisplayMode: 'metricSavings',
          metricSavings: { FCP: 300, LCP: 450 },
        },
        'is-on-https': { title: 'Usa HTTPS', score: 1, scoreDisplayMode: 'binary' },
        diagnostics: { title: 'Diagnóstico', score: null, scoreDisplayMode: 'informative' },
      },
    },
  };
}

describe('PageSpeedClient', () => {
  const realFetch = global.fetch;
  const realEnv = process.env.NODE_ENV;
  afterEach(() => {
    global.fetch = realFetch;
    process.env.NODE_ENV = realEnv;
  });

  function client(key?: string) {
    process.env.NODE_ENV = 'unit';
    const c = new PageSpeedClient(config(key));
    c.retryBaseMs = 0;
    return c;
  }

  it('pide las cuatro categorías en español con la clave y lee puntuaciones y laboratorio', async () => {
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify(response()));
    }) as typeof fetch;
    const r = await client('clave').run('https://a.es/', 'mobile');
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe(
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
    );
    expect(u.searchParams.get('strategy')).toBe('mobile');
    expect(u.searchParams.get('locale')).toBe('es');
    expect(u.searchParams.get('key')).toBe('clave');
    expect(u.searchParams.getAll('category')).toEqual([
      'performance',
      'seo',
      'accessibility',
      'best-practices',
    ]);
    expect(r.scores).toEqual({ performance: 63, seo: 92, accessibility: 88, bestPractices: 100 });
    expect(r.lab).toEqual({
      lcpMs: 3457,
      cls: 0.043,
      tbtMs: 310,
      fcpMs: 1500,
      siMs: 3900,
      ttiMs: 6000,
    });
    expect(r.opportunities.map((o) => [o.id, o.savingsMs])).toEqual([
      ['uses-optimized-images', 900],
      ['render-blocking-resources', 450],
    ]);
    // Sin datos de campo (CrUX): ni de la URL ni del sitio.
    expect(r.field).toBeNull();
  });

  it('sin clave no la manda', async () => {
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify(response()));
    }) as typeof fetch;
    await client().run('https://a.es/', 'desktop');
    expect(new URL(urls[0]!).searchParams.has('key')).toBe(false);
  });

  it('datos de campo de la URL, o del sitio si Google no tiene bastantes de la URL', () => {
    const withUrl = parsePageSpeed(response({ field: true }));
    expect(withUrl.field).toEqual({
      scope: 'url',
      overall: 'AVERAGE',
      lcpMs: 3100,
      lcpCategory: 'AVERAGE',
      inpMs: 180,
      inpCategory: 'FAST',
      cls: 0.12,
      clsCategory: 'AVERAGE',
    });
    const originOnly = parsePageSpeed(response({ originOnly: true }));
    expect(originOnly.field).toMatchObject({ scope: 'origin', overall: 'SLOW' });
    expect(originOnly.fieldRaw.url).toBeNull();
  });

  it('reintenta un 429 y un tiempo agotado; un 400 falla al momento', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n++;
      if (n === 1) return new Response('{}', { status: 429 });
      if (n === 2) {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(JSON.stringify(response()));
    }) as typeof fetch;
    await client().run('https://a.es/', 'mobile');
    expect(n).toBe(3);

    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'Lighthouse returned error' } }), {
        status: 400,
      });
    }) as typeof fetch;
    await expect(client().run('https://a.es/', 'mobile')).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);

    global.fetch = jest.fn(async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    }) as typeof fetch;
    const e = await client()
      .run('https://a.es/', 'mobile')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PageSpeedError);
    expect((e as PageSpeedError).status).toBe(0);
  });

  it('simulado: sin llamar a Google y determinista', async () => {
    process.env.NODE_ENV = 'test';
    global.fetch = jest.fn() as typeof fetch;
    const c = new PageSpeedClient(config());
    const a = await c.run('https://a.es/', 'mobile');
    const b = await c.run('https://a.es/', 'mobile');
    expect(a.scores).toEqual(b.scores);
    expect((await c.run('https://a.es/slow', 'mobile')).field?.overall).toBe('SLOW');
    expect((await c.run('https://a.es/nofield', 'mobile')).field?.scope).toBe('origin');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
