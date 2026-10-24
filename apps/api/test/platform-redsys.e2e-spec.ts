import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  signRequest,
} from '../src/modules/payments/redsys/redsys-signature';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'platform-redsys-admin@e2e.local';
// Clave pública del comercio de pruebas de Redsys.
const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

/** Pago de la suscripción con el TPV (Redsys) de la plataforma. */
describe('TPV Redsys de la plataforma (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminToken: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Redsys',
        role: 'superadmin',
      },
    });
    await admin.platformRedsysSettings.deleteMany({});
    app = await createTestApp();
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await admin.platformRedsysSettings.deleteMany({});
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('configurar el TPV, pagar un mes con tarjeta y registrar el pago con la notificación', async () => {
    const owner = await registerVerifiedUser(app, 'platredsys');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin TPV configurado no se ofrece.
    const before = await http().get('/settings/saas-billing/redsys').set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ available: false, reason: 'not_configured' });

    const noKey = await http()
      .put('/admin/platform-redsys/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ merchantCode: '999008881', terminal: '1', environment: 'test', enabled: true });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('redsys_secret_required');

    const saved = await http()
      .put('/admin/platform-redsys/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: TEST_KEY,
        environment: 'test',
        enabled: true,
        bizumEnabled: false,
      });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, hasSecretKey: true, bizumEnabled: false });
    expect(JSON.stringify(saved.body)).not.toContain(TEST_KEY);

    const sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
      include: { plan: true },
    });
    const options = await http().get('/settings/saas-billing/redsys').set(auth);
    expect(options.body).toMatchObject({ available: true, cardEnabled: true, bizumEnabled: false });
    expect(options.body.amount).toBeGreaterThan(0);

    // Bizum sin activar → 400.
    const bizum = await http()
      .post('/settings/saas-billing/redsys/redirect')
      .set(auth)
      .send({ payMethod: 'bizum' });
    expect(bizum.status).toBe(400);
    expect(bizum.body.code).toBe('bizum_not_enabled');

    const redirect = await http()
      .post('/settings/saas-billing/redsys/redirect')
      .set(auth)
      .send({ payMethod: 'card' });
    expect(redirect.status).toBe(200);
    const params = decodeMerchantParameters(redirect.body.merchantParameters);
    expect(params.DS_MERCHANT_PAYMETHODS).toBe('C');
    expect(params.DS_MERCHANT_MERCHANTURL).toMatch(/\/webhooks\/redsys\/platform$/);
    expect(Number(params.DS_MERCHANT_AMOUNT)).toBe(Math.round(options.body.amount * 100));
    const order = params.DS_MERCHANT_ORDER as string;

    // Doble clic: misma orden.
    const again = await http()
      .post('/settings/saas-billing/redsys/redirect')
      .set(auth)
      .send({ payMethod: 'card' });
    expect(decodeMerchantParameters(again.body.merchantParameters).DS_MERCHANT_ORDER).toBe(order);

    // Notificación con firma falsa: no hace nada.
    const notification = encodeMerchantParameters({ Ds_Order: order, Ds_Response: '0000' });
    await http()
      .post('/webhooks/redsys/platform')
      .send({ Ds_MerchantParameters: notification, Ds_Signature: 'falsa' })
      .expect(200);
    expect((await admin.platformRedsysOrder.findUniqueOrThrow({ where: { order } })).status).toBe(
      'pending',
    );

    // Notificación buena: pago registrado y periodo extendido un mes.
    const signed = {
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_MerchantParameters: notification,
      Ds_Signature: signRequest(notification, order, TEST_KEY),
    };
    await http().post('/webhooks/redsys/platform').send(signed).expect(200);
    // Reentrega: no cobra dos veces.
    await http().post('/webhooks/redsys/platform').send(signed).expect(200);

    const row = await admin.platformRedsysOrder.findUniqueOrThrow({ where: { order } });
    expect(row.status).toBe('paid');
    expect(row.paymentId).toBeTruthy();
    const payments = await admin.tenantSubscriptionPayment.findMany({
      where: { tenantId: owner.tenantId, provider: 'redsys' },
    });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0]!.amount)).toBeCloseTo(options.body.amount, 2);
    const after = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(sub.currentPeriodEnd.getTime());
    expect(after.status).toBe('active');
  });

  it('no se ofrece a quien paga por domiciliación ni a una cuenta exenta', async () => {
    const owner = await registerVerifiedUser(app, 'platredsysmode');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { billingMode: 'sepa' },
    });
    const sepa = await http().get('/settings/saas-billing/redsys').set(auth);
    expect(sepa.body).toMatchObject({ available: false, reason: 'not_manual' });
    const redirect = await http().post('/settings/saas-billing/redsys/redirect').set(auth).send({});
    expect(redirect.status).toBe(400);

    await admin.tenant.update({ where: { id: owner.tenantId }, data: { billingExempt: true } });
    const exempt = await http().get('/settings/saas-billing/redsys').set(auth);
    expect(exempt.body).toMatchObject({ available: false, reason: 'exempt' });
  });

  it('sin sesión no hay acceso', async () => {
    await http().get('/admin/platform-redsys/settings').expect(401);
    await http().get('/settings/saas-billing/redsys').expect(401);
  });
});
