import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ChatAlertsService } from '../src/modules/admin/chat-alerts.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-ac-test@storageos.local';

describe('Admin: «Hoy» con cifras y actividad, y avisos comerciales por chat (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin AC Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('«Hoy» trae las cifras y la actividad reciente (alta y extra contratado)', async () => {
    const owner = await registerVerifiedUser(app, 'adminact');
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const addon = await adminClient.subscriptionAddon.upsert({
      where: { slug: 'e2e-ac-addon' },
      update: {},
      create: { slug: 'e2e-ac-addon', name: 'Extra AC', priceMonthly: 15 },
    });
    await adminClient.tenantSubscriptionAddon.create({
      data: { tenantId: tenant.id, addonId: addon.id, priceMonthly: 15 },
    });

    const res = await request(app.getHttpServer())
      .get('/admin/today')
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    expect(res.body.kpis).toEqual(
      expect.objectContaining({
        mrr: expect.any(Number),
        collected7d: expect.any(Number),
        pending: expect.any(Number),
        trials: expect.any(Number),
        suspended: expect.any(Number),
        newThisMonth: expect.any(Number),
      }),
    );
    const mine = res.body.activity.filter((a: { tenantId: string }) => a.tenantId === tenant.id);
    expect(mine.map((a: { kind: string }) => a.kind).sort()).toEqual(['addon_added', 'signup']);
    expect(mine.find((a: { kind: string }) => a.kind === 'addon_added')).toMatchObject({
      text: 'Contrata Extra AC',
      amount: 15,
    });
    await adminClient.tenantSubscriptionAddon.deleteMany({ where: { addonId: addon.id } });
    await adminClient.subscriptionAddon.delete({ where: { id: addon.id } });
  });

  it('el aviso comercial manda lo nuevo desde el anterior, una vez', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const http = () => request(app.getHttpServer());
    await http()
      .put('/admin/chat-alerts')
      .set(auth)
      .send({
        telegramBotToken: '123456789:AAFakeTokenForTestsOnly_abcdefghij',
        telegramChatId: '-1001234567',
      })
      .expect(200);
    // Al activarlo empieza desde ahora: lo de antes no se manda.
    const on = await http()
      .put('/admin/chat-alerts')
      .set(auth)
      .send({ commercialEnabled: true })
      .expect(200);
    expect(on.body.commercialEnabled).toBe(true);
    const chat = app.get(ChatAlertsService);
    chat.sentForTests.length = 0;

    const owner = await registerVerifiedUser(app, 'adminchatnew');
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const first = await chat.sendCommercial(new Date(Date.now() + 1000));
    expect(first.sent).toBe(true);
    expect(chat.sentForTests[0]?.text).toContain(`${tenant.name}: Nueva alta`);

    chat.sentForTests.length = 0;
    const second = await chat.sendCommercial(new Date(Date.now() + 2000));
    expect(second.sent).toBe(false);
    expect(chat.sentForTests).toHaveLength(0);

    await http()
      .put('/admin/chat-alerts')
      .set(auth)
      .send({ commercialEnabled: false, telegramBotToken: '', telegramChatId: '' })
      .expect(200);
  });
});
