import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { StaffPushStatusDto } from '@storageos/shared';

describe('Push del equipo en el panel (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());
  const sub = (endpoint: string) => ({
    endpoint,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  });

  it('cada usuario activa y desactiva el push en su dispositivo', async () => {
    const owner = await registerVerifiedUser(app, 'staff-push');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const endpoint = 'https://push.example.com/staff-device-1';

    const before = await http()
      .get(`/me/push?endpoint=${encodeURIComponent(endpoint)}`)
      .set(auth)
      .expect(200);
    // En los tests no hay claves VAPID: la plataforma dice que no está configurado.
    expect(before.body as StaffPushStatusDto).toEqual({ publicKey: null, subscribed: false });

    await http().post('/me/push/subscribe').set(auth).send(sub(endpoint)).expect(204);
    const on = await http()
      .get(`/me/push?endpoint=${encodeURIComponent(endpoint)}`)
      .set(auth)
      .expect(200);
    expect(on.body.subscribed).toBe(true);

    const admin = app.get(PrismaAdminService);
    const row = await admin.pushSubscription.findUniqueOrThrow({ where: { endpoint } });
    expect(row.customerId).toBeNull();
    expect(row.userId).not.toBeNull();

    // Repetir la suscripción no duplica.
    await http().post('/me/push/subscribe').set(auth).send(sub(endpoint)).expect(204);
    expect(await admin.pushSubscription.count({ where: { endpoint } })).toBe(1);

    await http().post('/me/push/unsubscribe').set(auth).send({ endpoint }).expect(204);
    expect(await admin.pushSubscription.count({ where: { endpoint } })).toBe(0);

    await http().post('/me/push/subscribe').send(sub(endpoint)).expect(401);
    await http().post('/me/push/subscribe').set(auth).send({ endpoint: 'no-es-url' }).expect(400);
  });
});
