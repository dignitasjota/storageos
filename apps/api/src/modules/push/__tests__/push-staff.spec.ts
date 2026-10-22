import webpush from 'web-push';

import { PushService } from '../push.service';

import type { ConfigService } from '@nestjs/config';

type Sub = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user: { facilities: { facilityId: string }[] };
};

/** Prisma simulado: `withTenant` ejecuta la función con un `tx` de mentira. */
function makeService(subs: Sub[]) {
  const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const findMany = jest.fn().mockResolvedValue(subs);
  const tx = { pushSubscription: { findMany, deleteMany } };
  const prisma = { withTenant: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const keys = webpush.generateVAPIDKeys();
  const config = {
    get: (k: string) =>
      ({
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: 'mailto:test@example.com',
      })[k],
  } as unknown as ConfigService;
  const service = new PushService(prisma as never, config as never);
  return { service, findMany, deleteMany };
}

const sub = (id: string, facilities: string[]): Sub => ({
  id,
  endpoint: `https://push.example.com/${id}`,
  p256dh: 'p',
  auth: 'a',
  user: { facilities: facilities.map((facilityId) => ({ facilityId })) },
});

describe('PushService.sendToStaff', () => {
  let send: jest.SpyInstance;

  beforeEach(() => {
    send = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never);
  });
  afterEach(() => send.mockRestore());

  it('solo avisa de los tipos que piden actuar', async () => {
    const { service, findMany } = makeService([sub('a', [])]);
    await service.sendToStaff('t1', { type: 'invoice.paid', title: 'Pagada' });
    expect(findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    await service.sendToStaff('t1', {
      type: 'lead.created',
      title: 'Contacto nuevo',
      link: '/leads',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][1] as string)).toEqual({
      title: 'Contacto nuevo',
      url: '/leads',
    });
  });

  it('con local, solo a quien ve ese local (o no tiene locales asignados)', async () => {
    const { service } = makeService([sub('todos', []), sub('norte', ['F1']), sub('sur', ['F2'])]);
    await service.sendToStaff('t1', {
      type: 'incident.created',
      title: 'Incidencia',
      facilityId: 'F1',
    });
    const endpoints = send.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);
    expect(endpoints).toEqual(['https://push.example.com/todos', 'https://push.example.com/norte']);
  });

  it('borra las suscripciones que el navegador ya no acepta', async () => {
    const { service, deleteMany } = makeService([sub('vieja', [])]);
    send.mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));
    await service.sendToStaff('t1', { type: 'customer.message', title: 'Mensaje' });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'vieja' } });
  });
});
