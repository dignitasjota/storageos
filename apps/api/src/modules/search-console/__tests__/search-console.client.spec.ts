import { generateKeyPairSync } from 'node:crypto';

import { GoogleApiError } from '../../../common/google/google-service-account';
import { SearchConsoleClient } from '../search-console.client';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  client_email: 'seo@trasteros.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

const config = { get: () => KEY_JSON } as never;

type Reply = { status?: number; body: unknown };

/** `fetch` simulado: el token siempre vale y la API responde lo que toque. */
function mockFetch(replies: Reply[]) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('oauth2')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    calls.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    const reply = replies.shift() ?? { body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

const row = (k: string) => ({ keys: ['2026-11-01', k], clicks: 1, impressions: 10, position: 3 });

describe('SearchConsoleClient', () => {
  const realFetch = global.fetch;
  const realEnv = process.env.NODE_ENV;
  let client: SearchConsoleClient;

  beforeEach(() => {
    // Fuera de los tests usa la API de verdad (aquí, `fetch` simulado).
    process.env.NODE_ENV = 'unit';
    client = new SearchConsoleClient(config);
    client.retryBaseMs = 0;
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.NODE_ENV = realEnv;
  });

  it('pagina hasta que Google no devuelve más filas', async () => {
    const calls = mockFetch([
      { body: { rows: [row('a'), row('b')] } },
      { body: { rows: [row('c'), row('d')] } },
      { body: { rows: [row('e')] } },
    ]);
    const rows = await client.query('sc-domain:ejemplo.es', {
      startDate: '2026-11-01',
      endDate: '2026-11-01',
      dimensions: ['date', 'query'],
      rowLimit: 2,
    });
    expect(rows.map((r) => r.keys[1])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(calls.map((c) => c.body?.startRow)).toEqual([0, 2, 4]);
    expect(calls[0]!.url).toContain(
      `/sites/${encodeURIComponent('sc-domain:ejemplo.es')}/searchAnalytics/query`,
    );
    expect(rows[0]!.ctr).toBeCloseTo(0.1);
  });

  it('respeta el tope de filas', async () => {
    const calls = mockFetch([
      { body: { rows: [row('a'), row('b')] } },
      { body: { rows: [row('c')] } },
    ]);
    const rows = await client.query('sc-domain:ejemplo.es', {
      startDate: '2026-11-01',
      endDate: '2026-11-01',
      dimensions: ['date', 'query'],
      rowLimit: 2,
      maxRows: 3,
    });
    expect(rows).toHaveLength(3);
    expect(calls.map((c) => c.body?.rowLimit)).toEqual([2, 1]);
  });

  it('manda el tipo de búsqueda y los filtros', async () => {
    const calls = mockFetch([{ body: { rows: [] } }]);
    await client.query('https://ejemplo.es/', {
      startDate: '2026-11-01',
      endDate: '2026-11-07',
      dimensions: ['date', 'page', 'device'],
      searchType: 'image',
      filters: [
        { dimension: 'country', expression: 'esp' },
        { dimension: 'query', operator: 'contains', expression: 'trastero' },
      ],
    });
    expect(calls[0]!.body).toMatchObject({
      dimensions: ['date', 'page', 'device'],
      type: 'image',
      dimensionFilterGroups: [
        {
          groupType: 'and',
          filters: [
            { dimension: 'country', operator: 'equals', expression: 'esp' },
            { dimension: 'query', operator: 'contains', expression: 'trastero' },
          ],
        },
      ],
    });
  });

  it('ante un 429 espera y vuelve a intentarlo', async () => {
    const calls = mockFetch([
      { status: 429, body: { error: { message: 'Quota exceeded' } } },
      { status: 503, body: { error: { message: 'Backend error' } } },
      { body: { rows: [row('a')] } },
    ]);
    const rows = await client.query('sc-domain:ejemplo.es', {
      startDate: '2026-11-01',
      endDate: '2026-11-01',
      dimensions: ['date', 'query'],
    });
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it('un 429 que no cede acaba en error; un 403 no se reintenta', async () => {
    mockFetch(Array.from({ length: 5 }, () => ({ status: 429, body: {} })));
    await expect(
      client.query('sc-domain:ejemplo.es', {
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        dimensions: ['date'],
      }),
    ).rejects.toMatchObject({ status: 429 });

    const calls = mockFetch([{ status: 403, body: { error: { message: 'Forbidden' } } }]);
    await expect(
      client.query('sc-domain:ejemplo.es', {
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        dimensions: ['date'],
      }),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(calls).toHaveLength(1);
  });

  it('lista propiedades y mapas del sitio', async () => {
    mockFetch([
      { body: { siteEntry: [{ siteUrl: 'sc-domain:a.es', permissionLevel: 'siteFullUser' }] } },
      {
        body: {
          sitemap: [
            {
              path: 'https://a.es/sitemap.xml',
              warnings: '1',
              errors: '0',
              contents: [{ submitted: '10' }, { submitted: '5' }],
            },
          ],
        },
      },
    ]);
    expect(await client.listSites()).toEqual([
      { siteUrl: 'sc-domain:a.es', permissionLevel: 'siteFullUser' },
    ]);
    const [map] = await client.listSitemaps('sc-domain:a.es');
    expect(map).toMatchObject({ path: 'https://a.es/sitemap.xml', warnings: 1, submitted: 15 });
  });

  it('simulado: los cruces cuadran y la búsqueda no detalla una parte', async () => {
    process.env.NODE_ENV = 'test';
    const opts = { startDate: '2026-11-01', endDate: '2026-11-02' };
    const sum = (rows: { clicks: number; impressions: number }[]) =>
      rows.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
    const site = sum(await client.query('sc-domain:a.es', { ...opts, dimensions: ['date'] }));
    const byDevice = sum(
      await client.query('sc-domain:a.es', { ...opts, dimensions: ['date', 'device'] }),
    );
    const byQuery = sum(
      await client.query('sc-domain:a.es', { ...opts, dimensions: ['date', 'query'] }),
    );
    expect(byDevice).toEqual(site);
    expect(byQuery.c).toBeLessThan(site.c);
    expect(site.i - byQuery.i).toBe(30); // 15 impresiones sin detallar al día
    const filtered = await client.query('sc-domain:a.es', {
      ...opts,
      dimensions: ['date', 'query', 'country'],
      filters: [{ dimension: 'country', expression: 'fra' }],
    });
    expect(filtered.every((r) => r.keys[2] === 'fra' && r.clicks === 0)).toBe(true);
    expect(
      await client.query('sc-domain:a.es', { ...opts, dimensions: ['date'], searchType: 'news' }),
    ).toEqual([]);
  });
});
