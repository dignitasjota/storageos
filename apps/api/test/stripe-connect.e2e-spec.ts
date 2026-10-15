import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { RedsysService } from '../src/modules/payments/redsys/redsys.service';
import { StripeConnectService } from '../src/modules/payments/stripe-connect/stripe-connect.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
// Clave pública de pruebas de Redsys (la de su documentación).
const REDSYS_TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

/** Stripe Connect del tenant (cliente simulado en test) + proveedor de tarjeta. */
describe('Stripe Connect del tenant (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
  });

  it('conecta la cuenta, elige Stripe para la tarjeta y la desconecta', async () => {
    const owner = await registerVerifiedUser(app, 'stripeconnect');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());

    const initial = await http().get('/settings/stripe-connect').set(auth).expect(200);
    expect(initial.body).toMatchObject({
      platformAvailable: true,
      connected: false,
      cardProvider: null,
      effectiveCardProvider: null,
      applicationFeePct: 2,
    });

    // Sin cuenta lista no se puede elegir Stripe.
    const early = await http()
      .put('/settings/stripe-connect/card-provider')
      .set(auth)
      .send({ provider: 'stripe' });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('stripe_not_ready');
    // Ni Redsys sin activarlo.
    const noRedsys = await http()
      .put('/settings/stripe-connect/card-provider')
      .set(auth)
      .send({ provider: 'redsys' });
    expect(noRedsys.body.code).toBe('redsys_not_enabled');

    const link = await http()
      .post('/settings/stripe-connect/onboarding-link')
      .set(auth)
      .expect(200);
    expect(link.body.url).toContain('/settings/payments?stripe=return');
    // Un segundo enlace no crea otra cuenta.
    await http().post('/settings/stripe-connect/onboarding-link').set(auth).expect(200);
    expect(await admin.tenantStripeAccount.count({ where: { tenantId: owner.tenantId } })).toBe(1);

    const refreshed = await http().post('/settings/stripe-connect/refresh').set(auth).expect(200);
    expect(refreshed.body).toMatchObject({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    expect(refreshed.body.accountId).toMatch(/^acct_stub_/);

    const chosen = await http()
      .put('/settings/stripe-connect/card-provider')
      .set(auth)
      .send({ provider: 'stripe' })
      .expect(200);
    expect(chosen.body).toMatchObject({ cardProvider: 'stripe', effectiveCardProvider: 'stripe' });

    const dash = await http().post('/settings/stripe-connect/dashboard-link').set(auth).expect(200);
    expect(dash.body.url).toContain('stripe.com');

    // Con Redsys activo y Stripe elegido, manda Stripe.
    await http()
      .put('/settings/redsys')
      .set(auth)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: REDSYS_TEST_KEY,
        environment: 'test',
        enabled: true,
      })
      .expect(200);
    const both = await http().get('/settings/stripe-connect').set(auth).expect(200);
    expect(both.body).toMatchObject({ redsysEnabled: true, effectiveCardProvider: 'stripe' });
    // Redsys queda solo para Bizum y los cobros van a la cuenta del tenant.
    const redsys = await app.get(RedsysService, { strict: false }).availability(owner.tenantId);
    expect(redsys).toMatchObject({ enabled: true, cardEnabled: false });
    const ctx = await app.get(StripeConnectService, { strict: false }).cardContext(owner.tenantId);
    expect(ctx).toMatchObject({ mode: 'connect', applicationFeePct: 2 });
    expect((ctx as { accountId: string }).accountId).toBe(refreshed.body.accountId);
    const opts = await http().get('/payment-methods/options').set(auth).expect(200);
    expect(opts.body.cardPayments).toBe(true);

    // Desconectar vuelve a Redsys.
    const off = await http().delete('/settings/stripe-connect').set(auth).expect(200);
    expect(off.body).toMatchObject({
      connected: false,
      cardProvider: null,
      effectiveCardProvider: 'redsys',
    });
  });

  it('una cuenta con el registro a medias no se puede elegir', async () => {
    const owner = await registerVerifiedUser(app, 'stripeconnectpending');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await admin.tenantStripeAccount.create({
      data: { tenantId: owner.tenantId, stripeAccountId: `acct_stub_pending_${Date.now()}` },
    });
    const refreshed = await request(app.getHttpServer())
      .post('/settings/stripe-connect/refresh')
      .set(auth)
      .expect(200);
    expect(refreshed.body).toMatchObject({
      chargesEnabled: false,
      requirementsDue: ['external_account'],
    });
    const res = await request(app.getHttpServer())
      .put('/settings/stripe-connect/card-provider')
      .set(auth)
      .send({ provider: 'stripe' });
    expect(res.body.code).toBe('stripe_not_ready');
    await request(app.getHttpServer())
      .post('/settings/stripe-connect/dashboard-link')
      .set(auth)
      .expect(400);
  });

  it('el super admin ajusta la comisión de la plataforma', async () => {
    const sa = await seedSuperAdmin('payfee');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    await request(app.getHttpServer()).get('/admin/payment-settings').expect(401);
    const got = await request(app.getHttpServer()).get('/admin/payment-settings').set(auth);
    expect(got.status).toBe(200);
    expect(got.body.applicationFeePct).toBe(2);
    const upd = await request(app.getHttpServer())
      .put('/admin/payment-settings')
      .set(auth)
      .send({ applicationFeePct: 1.5 });
    expect(upd.body.applicationFeePct).toBe(1.5);
    await request(app.getHttpServer())
      .put('/admin/payment-settings')
      .set(auth)
      .send({ applicationFeePct: 50 })
      .expect(400);
    // Se restaura para no afectar a otras pruebas.
    await request(app.getHttpServer())
      .put('/admin/payment-settings')
      .set(auth)
      .send({ applicationFeePct: 2 })
      .expect(200);
  });
});
