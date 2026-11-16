import { WebChatAbuseService, webChatMessagesPerIp } from '../web-chat-abuse.service';

import type { Queue } from 'bullmq';

/** Redis simulado: solo lo que usa el servicio. */
function fakeRedis(fail = false) {
  const store = new Map<string, number>();
  const client = {
    incr: jest.fn(async (key: string) => {
      if (fail) throw new Error('sin conexión');
      const n = (store.get(key) ?? 0) + 1;
      store.set(key, n);
      return n;
    }),
    expire: jest.fn(async () => 1),
    decr: jest.fn(async (key: string) => {
      const n = (store.get(key) ?? 0) - 1;
      store.set(key, n);
      return n;
    }),
  };
  const queue = { client: Promise.resolve(client) } as unknown as Queue;
  return { service: new WebChatAbuseService(queue), client, store };
}

describe('WebChatAbuseService', () => {
  it('cuenta por negocio e IP y corta al pasar del límite', async () => {
    const { service, client } = fakeRedis();
    expect(await service.allow('conversation', 't1', '1.2.3.4', 2)).toBe(true);
    expect(await service.allow('conversation', 't1', '1.2.3.4', 2)).toBe(true);
    expect(await service.allow('conversation', 't1', '1.2.3.4', 2)).toBe(false);
    // Otra IP u otro negocio llevan su propia cuenta.
    expect(await service.allow('conversation', 't1', '5.6.7.8', 2)).toBe(true);
    expect(await service.allow('conversation', 't2', '1.2.3.4', 2)).toBe(true);
    // La IP no se guarda tal cual y la clave caduca sola.
    const keys = client.incr.mock.calls.map(([k]) => k as string);
    expect(keys.some((k) => k.includes('1.2.3.4'))).toBe(false);
    expect(client.expire).toHaveBeenCalled();
  });

  it('devolver una unidad deja hacer otra', async () => {
    const { service } = fakeRedis();
    expect(await service.allow('booking', 't1', '1.2.3.4', 1)).toBe(true);
    expect(await service.allow('booking', 't1', '1.2.3.4', 1)).toBe(false);
    await service.giveBack('booking', 't1', '1.2.3.4');
    await service.giveBack('booking', 't1', '1.2.3.4');
    expect(await service.allow('booking', 't1', '1.2.3.4', 1)).toBe(true);
  });

  it('sin IP o sin Redis deja pasar (no calla el chat de todos)', async () => {
    const { service } = fakeRedis(true);
    expect(await service.allow('message', 't1', '1.2.3.4', 1)).toBe(true);
    expect(await fakeRedis().service.allow('message', 't1', undefined, 0)).toBe(true);
  });

  it('el tope por negocio y hora no depende de la IP', async () => {
    const { service } = fakeRedis();
    expect(await service.allow('tenant_hour', 't1', undefined, 1)).toBe(true);
    expect(await service.allow('tenant_hour', 't1', '9.9.9.9', 1)).toBe(false);
  });

  it('mensajes por IP: el tope del visitante con margen', () => {
    expect(webChatMessagesPerIp(5)).toBe(30);
    expect(webChatMessagesPerIp(15)).toBe(45);
  });
});
