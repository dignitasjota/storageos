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
});
