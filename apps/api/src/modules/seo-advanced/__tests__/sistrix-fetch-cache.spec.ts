import { SistrixFetchService } from '../sistrix/sistrix-fetch.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { SeoProviderRegistry } from '../providers/seo-data-provider';
import type { SistrixConnectionsService } from '../sistrix/sistrix-connections.service';

/** Caché por fondo: dos proyectos que piden lo mismo hacen una sola consulta. */
function setup(mcpQuota: Date | null = null) {
  const cache: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  const admin = {
    seoApiCache: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          cache.find(
            (c) =>
              c.tenantId === where.tenantId &&
              c.queryHash === where.queryHash &&
              (!where.expiresAt || (c.expiresAt as Date) > new Date()),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        cache.push({ id: `c${cache.length}`, ...data });
        return data;
      }),
      update: jest.fn(),
    },
    seoApiRequest: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        requests.push(data);
        return data;
      }),
    },
    seoProviderConnection: { updateMany: jest.fn(async () => ({ count: 1 })) },
  } as unknown as PrismaAdminService;
  const mcp = { status: 'connected', quotaExhaustedUntil: mcpQuota };
  const connections = {
    find: jest.fn(async (_pool: unknown, provider: string) =>
      provider === 'sistrix_mcp' ? mcp : null,
    ),
    requestsToday: jest.fn(async () => requests.filter((r) => r.status !== 'cached').length),
    weekSpent: () => 0,
    ensure: jest.fn(async () => ({ id: 'mcp', quotaNotifiedAt: null })),
    update: jest.fn(async (_id: string, data: Record<string, unknown>) => Object.assign(mcp, data)),
    notifySuperAdmin: jest.fn(async () => undefined),
  } as unknown as SistrixConnectionsService;
  const query = jest.fn(async () => ({
    outcome: { kind: 'ok', data: { op: 'metrics', metrics: { traffic: 300 } }, dataDate: null },
    credits: 0,
    tool: 'keyword',
    view: 'metrics',
    args: { keyword: 'trasteros valencia', view: 'metrics', country: 'es' },
  }));
  const registry = { query: () => ({ query }) } as unknown as SeoProviderRegistry;
  const service = new SistrixFetchService(admin, connections, registry);
  return { service, query, requests, connections };
}

const ctx = (projectId: string) => ({
  pool: null,
  projectId,
  runId: null,
  ttlDays: 29,
  maxPerDay: 100,
});
const q = { op: 'metrics' as const, keyword: 'trasteros valencia', country: 'es' };

describe('SistrixFetchService: caché y deduplicación', () => {
  it('GUÁRDALO y trasteros.pro piden la misma palabra: una sola consulta a SISTRIX', async () => {
    const { service, query, requests } = setup();
    const a = await service.fetch(ctx('guardalo'), q);
    const b = await service.fetch(ctx('trasteros'), q);
    expect(query).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ kind: 'data', fromCache: false, provider: 'sistrix_mcp' });
    expect(b).toMatchObject({ kind: 'data', fromCache: true, provider: 'sistrix_mcp' });
    expect(requests.map((r) => r.status)).toEqual(['ok', 'cached']);
  });

  it('el fondo de un tenant no reutiliza lo de la plataforma', async () => {
    const { service, query } = setup();
    await service.fetch(ctx('p'), q);
    const tenant = await service.fetch({ ...ctx('t'), pool: 'tenant-1' } as never, q);
    // El tenant no tiene clave: espera, y no se le sirve lo de la plataforma.
    expect(tenant).toMatchObject({ kind: 'wait', reason: 'not_connected' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('con la cuota del MCP agotada y sin autorización, espera sin gastar', async () => {
    const until = new Date(Date.now() + 3600_000);
    const { service, query } = setup(until);
    expect(await service.fetch(ctx('p'), q)).toEqual({ kind: 'wait', reason: 'mcp_quota', until });
    expect(query).not.toHaveBeenCalled();
  });

  it('al llegar al máximo diario de consultas, espera', async () => {
    const { service } = setup();
    expect(await service.fetch({ ...ctx('p'), maxPerDay: 0 }, q)).toMatchObject({
      kind: 'wait',
      reason: 'daily_limit',
    });
  });
});
