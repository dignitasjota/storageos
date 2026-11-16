import { MetaGraphClient, MetaGraphError } from '../meta-graph.client';

type Handler = (path: string, params: URLSearchParams) => { status?: number; body: unknown };

/** `fetch` simulado: responde según la ruta de la Graph API. */
function mockFetch(handler: Handler): jest.Mock {
  const fn = jest.fn(async (url: string) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v\d+\.\d+/, '');
    const { status = 200, body } = handler(path, u.searchParams);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const metaError = (message: string, code: number) => ({
  status: 400,
  body: { error: { message, code } },
});

describe('MetaGraphClient (real)', () => {
  const env = process.env.NODE_ENV;
  let client: MetaGraphClient;

  beforeAll(() => {
    process.env.NODE_ENV = 'development';
  });
  afterAll(() => {
    process.env.NODE_ENV = env;
  });
  beforeEach(() => {
    client = new MetaGraphClient();
  });

  it('un token de página (sin «cuentas») se usa como la propia página', async () => {
    mockFetch((path) => {
      if (path === '/me/accounts') return metaError('nonexisting field (accounts)', 100);
      return {
        body: {
          id: '555',
          name: 'Mi página',
          instagram_business_account: { id: '1784', username: 'mi_ig' },
        },
      };
    });
    const pages = await client.pages('PAGE_TOKEN');
    expect(pages).toEqual([
      {
        id: '555',
        name: 'Mi página',
        accessToken: 'PAGE_TOKEN',
        instagramUserId: '1784',
        instagramUsername: 'mi_ig',
      },
    ]);
  });

  it('el token va en la cabecera, nunca en la dirección', async () => {
    const fn = mockFetch(() => ({ body: { data: [] } }));
    await client.pages('SECRETO').catch(() => undefined);
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).not.toContain('SECRETO');
    expect(url).not.toContain('access_token=');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer SECRETO');
  });

  it('un token caducado lanza el error de Meta', async () => {
    mockFetch(() => metaError('Error validating access token', 190));
    await expect(client.pages('OLD')).rejects.toMatchObject({ code: 190 });
    await expect(client.pages('OLD')).rejects.toBeInstanceOf(MetaGraphError);
  });

  it('fechas de Meta (fin del día) y métricas retiradas sin romper el resto', async () => {
    mockFetch((path, params) => {
      const metric = params.get('metric') ?? '';
      if (path === '/555/insights') {
        // Una métrica que Meta ya no da: error que no debe tumbar la descarga.
        if (metric === 'page_media_view')
          return metaError('(#100) The value must be a valid insights metric', 100);
        return {
          body: {
            data: [
              {
                name: metric,
                values: [
                  { value: 10, end_time: '2026-10-20T07:00:00+0000' },
                  { value: 12, end_time: '2026-10-21T07:00:00+0000' },
                ],
              },
            ],
          },
        };
      }
      if (path === '/1784/insights') {
        if (params.get('metric_type') === 'total_value') {
          // La petición conjunta falla; se reintenta métrica a métrica.
          if (metric.includes(',')) return metaError('(#100) metric[0] must be one of …', 100);
          if (metric === 'profile_views') return metaError('(#100) deprecated', 100);
          return { body: { data: [{ name: metric, total_value: { value: 7 } }] } };
        }
        return {
          body: {
            data: [
              { name: metric, values: [{ value: 300, end_time: '2026-10-21T07:00:00+0000' }] },
            ],
          },
        };
      }
      if (path === '/555') return { body: { followers_count: 900 } };
      if (path === '/1784') return { body: { followers_count: 1500 } };
      return { body: {} };
    });
    const rows = await client.daily(
      {
        id: '555',
        name: 'Mi página',
        accessToken: 'T',
        instagramUserId: '1784',
        instagramUsername: 'mi_ig',
      },
      '2026-10-20',
      '2026-10-20',
    );
    const fb = rows.find((r) => r.network === 'facebook' && r.date === '2026-10-20');
    // end_time 21 → día 20; end_time 20 → día 19 (fuera del rango).
    expect(fb).toMatchObject({ reach: 12, views: null, followers: 12, engagements: 12 });
    const ig = rows.find((r) => r.network === 'instagram' && r.date === '2026-10-20');
    expect(ig).toMatchObject({
      reach: 300,
      views: 7,
      profileViews: null,
      websiteClicks: 7,
      engagements: 7,
      followers: 1500,
    });
  });

  it('sin permisos para leer las métricas, el error sí se propaga', async () => {
    mockFetch(() => metaError('(#10) Application does not have permission', 10));
    await expect(
      client.daily(
        { id: '555', name: 'P', accessToken: 'T', instagramUserId: null, instagramUsername: null },
        '2026-10-20',
        '2026-10-20',
      ),
    ).rejects.toMatchObject({ code: 10 });
  });

  it('un token de usuario sin páginas da una lista vacía (no un error confuso)', async () => {
    const fn = mockFetch((path) => {
      if (path === '/me/accounts') return { body: { data: [] } };
      return metaError('Tried accessing nonexisting field (instagram_business_account)', 100);
    });
    await expect(client.pages('USER_TOKEN')).resolves.toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sigue las páginas de resultados de /me/accounts', async () => {
    mockFetch((path, params) => {
      if (path !== '/me/accounts') return { body: {} };
      if (!params.get('after')) {
        return {
          body: {
            data: [{ id: '1', name: 'Uno', access_token: 'T1' }],
            paging: { next: 'https://x', cursors: { after: 'C1' } },
          },
        };
      }
      return { body: { data: [{ id: '2', name: 'Dos', access_token: 'T2' }] } };
    });
    const pages = await client.pages('USER_TOKEN');
    expect(pages.map((p) => p.id)).toEqual(['1', '2']);
  });

  it('un límite de llamadas de Meta se avisa en vez de quedar como «sin datos»', async () => {
    mockFetch(() => metaError('(#4) Application request limit reached', 4));
    await expect(
      client.daily(
        { id: '555', name: 'P', accessToken: 'T', instagramUserId: null, instagramUsername: null },
        '2026-10-20',
        '2026-10-20',
      ),
    ).rejects.toMatchObject({ code: 4 });
  });

  it('un error pasajero de Meta se reintenta', async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      if (calls === 1) return { status: 503, body: { error: { message: 'Service unavailable' } } };
      return { body: { data: [{ id: '9', name: 'Nueve', access_token: 'T9' }] } };
    });
    const pages = await client.pages('USER_TOKEN');
    expect(pages.map((p) => p.id)).toEqual(['9']);
    expect(calls).toBe(2);
  });

  it('publicaciones: sigue las páginas y pide las cifras de Instagram una a una si hace falta', async () => {
    const since = '2026-09-01';
    mockFetch((path, params) => {
      if (path === '/555/posts') {
        if (!params.get('after')) {
          return {
            body: {
              data: [{ id: 'fb1', created_time: '2026-10-10T10:00:00+0000' }],
              paging: { next: 'https://x', cursors: { after: 'P2' } },
            },
          };
        }
        return { body: { data: [{ id: 'fb2', created_time: '2026-09-20T10:00:00+0000' }] } };
      }
      if (path === '/1784/media') {
        return {
          body: {
            data: [{ id: 'ig1', timestamp: '2026-10-11T10:00:00+0000', media_type: 'REEL' }],
          },
        };
      }
      if (path === '/ig1/insights') {
        const metric = params.get('metric') ?? '';
        // La petición conjunta falla por una métrica que no vale para un reel.
        if (metric.includes(',')) return metaError('(#100) saved not supported', 100);
        if (metric === 'saved') return metaError('(#100) not supported', 100);
        return { body: { data: [{ name: metric, values: [{ value: 50 }] }] } };
      }
      return { body: {} };
    });
    const res = await client.posts(
      { id: '555', name: 'P', accessToken: 'T', instagramUserId: '1784', instagramUsername: 'x' },
      since,
    );
    expect(res.complete.sort()).toEqual(['facebook', 'instagram']);
    expect(res.posts.filter((p) => p.network === 'facebook').map((p) => p.externalId)).toEqual([
      'fb1',
      'fb2',
    ]);
    const ig = res.posts.find((p) => p.network === 'instagram')!;
    expect(ig).toMatchObject({ reach: 50, views: 50, shares: 50, saves: null });
  });
});
