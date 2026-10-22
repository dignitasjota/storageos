import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { PushService } from '../src/modules/push/push.service';
import { SuperAdminPushService } from '../src/modules/push/super-admin-push.service';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ENDPOINT = `https://push.example.com/admin-${Date.now()}`;
const KEYS = { p256dh: 'BPk-test-key', auth: 'auth-test' };

describe('Push del super admin (e2e)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    const seeded = await seedSuperAdmin('push');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: seeded.email, password: seeded.password })
      .expect(200);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    const admin = app.get(PrismaAdminService);
    await admin.superAdminPushSubscription.deleteMany({ where: { endpoint: ENDPOINT } });
    await app.close();
    await cleanupSuperAdmins();
  });

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('activa y desactiva el push en un dispositivo', async () => {
    const before = await http().get('/admin/me/push').query({ endpoint: ENDPOINT }).set(auth());
    expect(before.status).toBe(200);
    expect(before.body.subscribed).toBe(false);

    await http()
      .post('/admin/me/push/subscribe')
      .set(auth())
      .send({ endpoint: ENDPOINT, keys: KEYS })
      .expect(204);
    const on = await http().get('/admin/me/push').query({ endpoint: ENDPOINT }).set(auth());
    expect(on.body.subscribed).toBe(true);

    // Volver a activarlo en el mismo navegador no duplica.
    await http()
      .post('/admin/me/push/subscribe')
      .set(auth())
      .send({ endpoint: ENDPOINT, keys: KEYS })
      .expect(204);
    const admin = app.get(PrismaAdminService);
    expect(await admin.superAdminPushSubscription.count({ where: { endpoint: ENDPOINT } })).toBe(1);

    await http()
      .post('/admin/me/push/unsubscribe')
      .set(auth())
      .send({ endpoint: ENDPOINT })
      .expect(204);
    const off = await http().get('/admin/me/push').query({ endpoint: ENDPOINT }).set(auth());
    expect(off.body.subscribed).toBe(false);

    await http().get('/admin/me/push').expect(401);
  });

  it('cada aviso nuevo sale una sola vez y solo los que piden actuar', async () => {
    const admin = app.get(PrismaAdminService);
    await http()
      .post('/admin/me/push/subscribe')
      .set(auth())
      .send({ endpoint: ENDPOINT, keys: KEYS })
      .expect(204);

    // En los tests no hay claves VAPID: se simula que el push está configurado.
    const push = app.get(PushService);
    jest.spyOn(push, 'getPublicKey').mockReturnValue('test-public-key');
    const sendOne = jest.spyOn(push, 'sendOne').mockResolvedValue('sent');
    const service = app.get(SuperAdminPushService);
    // Lo que hubiera pendiente de otras pruebas se da por enviado.
    await admin.superAdminNotification.updateMany({
      where: { pushedAt: null },
      data: { pushedAt: new Date() },
    });

    const ticket = await admin.superAdminNotification.create({
      data: { type: 'support_ticket', title: 'Ticket push e2e', link: '/admin/support/x' },
    });
    const quiet = await admin.superAdminNotification.create({
      data: { type: 'platform_invoice.incomplete_recipient', title: 'Factura sin NIF' },
    });
    // Uno antiguo que no llegó a salir (p. ej. el worker estaba parado): no se manda.
    const old = await admin.superAdminNotification.create({
      data: {
        type: 'support_ticket',
        title: 'Ticket antiguo',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });

    const result = await service.sendPending();
    expect(result.notifications).toBe(1);
    const toMe = sendOne.mock.calls.filter(([sub]) => sub.endpoint === ENDPOINT);
    expect(toMe.map(([, payload]) => payload)).toEqual([
      { title: 'Ticket push e2e', url: '/admin/support/x' },
    ]);

    const rows = await admin.superAdminNotification.findMany({
      where: { id: { in: [ticket.id, quiet.id, old.id] } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ticket.id)!.pushedAt).not.toBeNull();
    expect(byId.get(quiet.id)!.pushedAt).not.toBeNull();
    expect(byId.get(old.id)!.pushedAt).toBeNull();

    // Una segunda pasada no repite nada.
    sendOne.mockClear();
    expect(await service.sendPending()).toEqual({ notifications: 0, sent: 0 });
    expect(sendOne).not.toHaveBeenCalled();

    await admin.superAdminNotification.deleteMany({
      where: { id: { in: [ticket.id, quiet.id, old.id] } },
    });
    jest.restoreAllMocks();
  });
});
