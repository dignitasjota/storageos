import { SistrixInvalidGrantError, SistrixNotConnectedError } from '../sistrix/sistrix-errors';
import { SISTRIX_REFRESH_LOCK, SistrixMcpClient } from '../sistrix/sistrix-mcp.client';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { SistrixConnectionsService } from '../sistrix/sistrix-connections.service';
import type { SistrixMcpGateway } from '../sistrix/sistrix-mcp.gateway';

/**
 * Renovación con bloqueo: SISTRIX rota el refresh token, así que dos procesos
 * no pueden renovar a la vez. La base de datos se simula en memoria y el
 * bloqueo (`pg_advisory_xact_lock`) con una cola.
 */
function setup(initial: { expiresInMs: number }) {
  const row: Record<string, unknown> = {
    id: 'conn-1',
    tenantId: null,
    provider: 'sistrix_mcp',
    status: 'connected',
    accessTokenEncrypted: 'enc:access:A1',
    refreshTokenEncrypted: 'enc:refresh:R1',
    tokenExpiresAt: new Date(Date.now() + initial.expiresInMs),
    oauthMetadata: { authorizationServerUrl: 'https://as', metadata: null, resource: null },
    clientInfoEncrypted:
      'enc:client:{"clientId":"c","clientSecret":"s","redirectUri":"https://cb"}',
  };
  const events: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      events.push(`lock:${strings.join('?')}:${String(values[0])}`);
      return 1;
    }),
    seoProviderConnection: {
      findFirst: jest.fn(async () => {
        events.push('read');
        return { ...row };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push('write');
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
  const admin = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => {
      // El bloqueo serializa las transacciones.
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    }),
  } as unknown as PrismaAdminService;
  const connections = {
    find: jest.fn(async () => ({ ...row })),
    encrypt: (_p: unknown, _pr: unknown, field: string, v: string) => `enc:${field}:${v}`,
    decrypt: (_p: unknown, _pr: unknown, field: string, v: string) =>
      v.replace(`enc:${field}:`, ''),
    notifySuperAdmin: jest.fn(async () => undefined),
  } as unknown as SistrixConnectionsService;
  let seq = 1;
  const gateway = {
    refresh: jest.fn(async (_s: unknown, _c: unknown, refreshToken: string) => {
      if (refreshToken !== `R${seq}`) throw new SistrixInvalidGrantError();
      await new Promise((r) => setTimeout(r, 5));
      seq += 1;
      return {
        accessToken: `A${seq}`,
        refreshToken: `R${seq}`,
        expiresAt: new Date(Date.now() + 3600_000),
        scope: 'sistrix',
      };
    }),
  } as unknown as SistrixMcpGateway;
  const client = new SistrixMcpClient(admin, connections, gateway);
  return { client, row, events, gateway, connections };
}

describe('SistrixMcpClient: renovación con bloqueo y refresh token que rota', () => {
  it('con el token a punto de caducar, renueva dentro del bloqueo y guarda el nuevo refresh', async () => {
    const { client, row, events, gateway } = setup({ expiresInMs: 30_000 });
    expect(await client.accessToken()).toBe('A2');
    expect(gateway.refresh).toHaveBeenCalledTimes(1);
    expect(events[0]).toContain('pg_advisory_xact_lock');
    expect(events[0]).toContain(SISTRIX_REFRESH_LOCK);
    expect(events.slice(1)).toEqual(['read', 'write']);
    expect(row.refreshTokenEncrypted).toBe('enc:refresh:R2');
    expect(row.accessTokenEncrypted).toBe('enc:access:A2');
  });

  it('dos renovaciones a la vez: solo una llama a SISTRIX y la otra usa el token nuevo', async () => {
    const { client, gateway } = setup({ expiresInMs: 30_000 });
    const [a, b] = await Promise.all([client.refresh('A1'), client.refresh('A1')]);
    expect(gateway.refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe('A2');
    expect(b).toBe('A2');
  });

  it('si el token guardado no caduca y no es el que falló, no se renueva', async () => {
    const { client, gateway } = setup({ expiresInMs: 3600_000 });
    expect(await client.refresh('otro')).toBe('A1');
    expect(gateway.refresh).not.toHaveBeenCalled();
  });

  it('`invalid_grant`: queda «hay que volver a conectar», se avisa y se para', async () => {
    const { client, row, connections } = setup({ expiresInMs: 30_000 });
    row.refreshTokenEncrypted = 'enc:refresh:VIEJO';
    await expect(client.refresh('A1')).rejects.toBeInstanceOf(SistrixNotConnectedError);
    expect(row.status).toBe('needs_reauth');
    expect(connections.notifySuperAdmin).toHaveBeenCalledWith(
      'seo.sistrix_reauth',
      expect.any(String),
      expect.any(String),
    );
  });
});
