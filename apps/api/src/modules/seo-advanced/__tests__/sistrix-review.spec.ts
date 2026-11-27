import { type RouteApiState, decideSistrixRoute } from '../providers/seo-provider-router';
import { SistrixApiClient } from '../sistrix/sistrix-api.client';
import { SistrixUnauthorizedError } from '../sistrix/sistrix-errors';
import { SdkSistrixMcpGateway } from '../sistrix/sistrix-mcp.gateway';
import {
  estimateApiCallCredits,
  estimateApiCredits,
  normalizeSistrix,
  parseApiResponse,
} from '../sistrix/sistrix-normalizer';
import { SistrixSyncService, sistrixPoolCanServe } from '../sistrix/sistrix-sync.service';

const NOW = new Date('2026-11-25T12:00:00Z');
const api = (over: Partial<RouteApiState> = {}): RouteApiState => ({
  enabled: true,
  hasKey: true,
  authorizedUntil: null,
  weeklyBudget: 500,
  weekSpent: 0,
  ...over,
});

describe('Presupuesto de la API de SISTRIX: la consulta tiene que caber', () => {
  it('con 1 crédito de margen, una consulta de 100 filas no se hace', () => {
    const decision = decideSistrixRoute(
      {
        pool: 'tenant',
        mcp: null,
        api: api({ weekSpent: 499 }),
        supportsApi: true,
        estimatedCredits: 100,
      },
      NOW,
    );
    expect(decision).toEqual({ provider: null, waitReason: 'api_budget', until: null });
  });

  it('si cabe, va por la API', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'tenant',
          mcp: null,
          api: api({ weekSpent: 400 }),
          supportsApi: true,
          estimatedCredits: 100,
        },
        NOW,
      ),
    ).toMatchObject({ provider: 'sistrix_api' });
  });

  it('estima los créditos: una por fila pedida y cinco por palabra en las métricas', () => {
    expect(estimateApiCallCredits('domain.competitors.seo', { num: '10' })).toBe(10);
    expect(estimateApiCallCredits('domain.kwcount.seo', {})).toBe(1);
    expect(estimateApiCallCredits('keyword.seo.metrics', {})).toBe(5);
    expect(
      estimateApiCredits({
        op: 'visindex',
        domain: 'a.es',
        country: 'es',
        history: true,
        limit: 26,
      }),
    ).toBe(26);
    expect(estimateApiCredits({ op: 'ai_overview', country: 'es', domain: 'a.es' })).toBeNull();
  });

  it('si la respuesta no dice cuánto gastó, se asume lo estimado y nunca 0', async () => {
    const client = new SistrixApiClient({ get: () => 'real' } as never);
    // Fuerza el camino real con una respuesta sin el bloque de créditos.
    (client as unknown as { simulated: boolean }).simulated = false;
    (client as unknown as { request: () => Promise<unknown> }).request = async () => ({
      answer: [{ domain: [{ rows: 1 }] }],
    });
    const res = await client.call('key', 'keyword.seo.metrics', { kw: 'a', country: 'es' });
    expect(res.credits).toBe(5);
    expect(parseApiResponse({ answer: [{ x: 1 }], credits: [{ used: 3 }] }).creditsKnown).toBe(
      true,
    );
  });
});

describe('Una respuesta con contenido que no entendemos no es «sin datos»', () => {
  it('con filas que no reconoce, error unknown_shape (no se cachea como vacío)', () => {
    const out = normalizeSistrix('kwcount', {
      kind: 'payload',
      value: { kwcount: [{ total: 12 }] },
    });
    expect(out).toMatchObject({ kind: 'error', code: 'unknown_shape' });
  });

  it('una lista vacía de verdad sigue siendo vacío', () => {
    expect(normalizeSistrix('serp', { kind: 'payload', value: { rows: [] } })).toEqual({
      kind: 'empty',
    });
  });

  it('el 7010 en un mensaje de error es la cuota', () => {
    expect(
      normalizeSistrix('serp', {
        kind: 'error',
        code: null,
        message: 'SISTRIX API Error (7010): limit',
      }),
    ).toMatchObject({ kind: 'quota' });
  });
});

describe('Tandas de SISTRIX: la visibilidad en IA solo la sirve la plataforma', () => {
  it('un fondo de tenant no puede pedir ai_visibility', () => {
    expect(sistrixPoolCanServe('tenant-1', 'ai_visibility')).toBe(false);
    expect(sistrixPoolCanServe(null, 'ai_visibility')).toBe(true);
    expect(sistrixPoolCanServe('tenant-1', 'serp')).toBe(true);
  });
});

describe('Tandas de SISTRIX: rotación y trozos', () => {
  const domains = Array.from({ length: 5 }, (_, i) => ({
    domain: `d${i}.es`,
    role: i === 0 ? 'primary' : 'secondary',
  }));
  const project = {
    id: 'p',
    tenantId: null,
    country: 'ES',
    brandTerms: [],
    aiVisibilitySettings: {},
    domains,
    competitors: [],
  };
  const admin = {
    seoDomainMetric: { count: async () => 1 },
  };
  const svc = new SistrixSyncService(
    admin as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('la tanda coge un trozo y la siguiente continúa donde acabó', async () => {
    // 5 dominios × 2 consultas = 10; 6 por tanda → 3 dominios, quedan 4 consultas.
    const first = await svc.planItems(project as never, 'visibility', 6, 0);
    expect(first.items).toHaveLength(6);
    expect(first.total).toBe(10);
    expect(first.remaining).toBe(4);
    expect(first.nextOffset).toBe(3);
    const second = await svc.planItems(project as never, 'visibility', 6, first.nextOffset);
    const domainsOf = (items: { q: { domain?: string } }[]) => [
      ...new Set(items.map((i) => i.q.domain)),
    ];
    expect(domainsOf(first.items)).toEqual(['d0.es', 'd1.es', 'd2.es']);
    expect(domainsOf(second.items)).toEqual(['d3.es', 'd4.es', 'd0.es']);
  });

  it('con un máximo que cubre todo, no queda nada fuera', async () => {
    const all = await svc.planItems(project as never, 'visibility', 60, 0);
    expect(all.items).toHaveLength(10);
    expect(all.remaining).toBe(0);
  });
});

describe('Cliente MCP real: un 401 llega como 401 (para poder renovar)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sin proveedor OAuth en el transporte, el 401 del servidor es SistrixUnauthorizedError', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } }),
      );
    const gateway = new SdkSistrixMcpGateway();
    await expect(gateway.listTools('token-caducado')).rejects.toBeInstanceOf(
      SistrixUnauthorizedError,
    );
    // El token va en la cabecera y no se intentó registrar ni autorizar nada.
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const init = calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-caducado');
    expect(calls.every((c) => String(c[0]).includes('/mcp'))).toBe(true);
  });
});
