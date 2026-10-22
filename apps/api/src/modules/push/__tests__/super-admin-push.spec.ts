import { SuperAdminPushService } from '../super-admin-push.service';

import type { PushService } from '../push.service';

type Row = { type: string; title: string; body: string | null; link: string | null };

function makeService(rows: Row[], opts: { enabled?: boolean; subs?: number } = {}) {
  const subs = Array.from({ length: opts.subs ?? 1 }, (_, i) => ({
    id: `s${i}`,
    endpoint: `https://push.example.com/${i}`,
    p256dh: 'p',
    auth: 'a',
  }));
  const queryRaw = jest.fn().mockResolvedValue(rows);
  const findMany = jest.fn().mockResolvedValue(subs);
  const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const admin = {
    $queryRaw: queryRaw,
    superAdminPushSubscription: { findMany, deleteMany },
  };
  const sendOne = jest.fn().mockResolvedValue('sent');
  const push = {
    getPublicKey: () => (opts.enabled === false ? null : 'pub'),
    sendOne,
  } as unknown as PushService;
  return {
    service: new SuperAdminPushService(admin as never, push),
    queryRaw,
    findMany,
    deleteMany,
    sendOne,
  };
}

const row = (type: string, title: string, link: string | null = null): Row => ({
  type,
  title,
  body: null,
  link,
});

describe('SuperAdminPushService.sendPending', () => {
  it('sin claves VAPID no reclama nada (los avisos quedan para cuando se configure)', async () => {
    const { service, queryRaw } = makeService([row('support_ticket', 'Ticket')], {
      enabled: false,
    });
    expect(await service.sendPending()).toEqual({ notifications: 0, sent: 0 });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('solo envía los tipos que piden actuar, con su enlace', async () => {
    const { service, sendOne } = makeService([
      row('platform_invoice.incomplete_recipient', 'Factura sin NIF'),
      row('approval.requested', 'Soporte pide aprobar', '/admin/today'),
    ]);
    expect(await service.sendPending()).toEqual({ notifications: 1, sent: 1 });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(sendOne.mock.calls[0]![1]).toEqual({
      title: 'Soporte pide aprobar',
      url: '/admin/today',
    });
  });

  it('con muchos a la vez manda uno solo con el recuento', async () => {
    const { service, sendOne } = makeService(
      ['A', 'B', 'C', 'D', 'E'].map((t) => row('support_ticket', `Ticket ${t}`)),
      { subs: 2 },
    );
    expect(await service.sendPending()).toEqual({ notifications: 5, sent: 2 });
    expect(sendOne).toHaveBeenCalledTimes(2);
    expect(sendOne.mock.calls[0]![1]).toMatchObject({
      title: '5 avisos nuevos en TrasterOS',
      body: 'Ticket A · Ticket B · Ticket C',
      url: '/admin/notifications',
    });
  });

  it('borra las suscripciones que el navegador ya no acepta', async () => {
    const { service, sendOne, deleteMany } = makeService([row('support_ticket', 'Ticket')], {
      subs: 2,
    });
    sendOne.mockResolvedValueOnce('gone').mockResolvedValueOnce('sent');
    expect(await service.sendPending()).toEqual({ notifications: 1, sent: 1 });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s0'] } } });
  });

  it('sin avisos que envíen no busca dispositivos', async () => {
    const { service, findMany } = makeService([row('feature_trial.ended', 'Prueba acabada')]);
    expect(await service.sendPending()).toEqual({ notifications: 0, sent: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });
});
