import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformRedsysService } from '../src/modules/billing-saas/platform-redsys/platform-redsys.service';
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

  /** Paga un mes guardando la tarjeta: el aviso trae la referencia de Redsys. */
  async function payAndSaveCard(token: string, identifier: string): Promise<void> {
    const auth = { Authorization: `Bearer ${token}` };
    const redirect = await http()
      .post('/settings/saas-billing/redsys/redirect')
      .set(auth)
      .send({ payMethod: 'card', saveCard: true });
    expect(redirect.status).toBe(200);
    const params = decodeMerchantParameters(redirect.body.merchantParameters);
    expect(params).toMatchObject({
      DS_MERCHANT_IDENTIFIER: 'REQUIRED',
      DS_MERCHANT_COF_INI: 'S',
      DS_MERCHANT_COF_TYPE: 'R',
    });
    const order = params.DS_MERCHANT_ORDER as string;
    const mp = encodeMerchantParameters({
      Ds_Order: order,
      Ds_Response: '0000',
      Ds_Merchant_Identifier: identifier,
      Ds_Merchant_Cof_Txnid: 'TXN123',
      Ds_Card_Number: '454881******0003',
      Ds_ExpiryDate: '2912',
      Ds_Card_Brand: '1',
    });
    await http()
      .post('/webhooks/redsys/platform')
      .send({ Ds_MerchantParameters: mp, Ds_Signature: signRequest(mp, order, TEST_KEY) })
      .expect(200);
  }

  async function enableCardOnFile(): Promise<void> {
    const res = await http()
      .put('/admin/platform-redsys/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: TEST_KEY,
        environment: 'test',
        enabled: true,
        bizumEnabled: true,
        cardOnFileEnabled: true,
      });
    expect(res.status).toBe(200);
  }

  /** Deja la suscripción vencida (le toca el cobro automático). */
  async function makeDue(tenantId: string): Promise<void> {
    await admin.tenantSubscription.update({
      where: { tenantId },
      data: { currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000), status: 'active' },
    });
  }

  it('guardar la tarjeta pasa a cobro automático y se cobra sola al vencer', async () => {
    await enableCardOnFile();
    const owner = await registerVerifiedUser(app, 'platredsysauto');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await payAndSaveCard(owner.accessToken, 'stub-ok-card');

    const sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub.billingMode).toBe('redsys');
    const options = await http().get('/settings/saas-billing/redsys').set(auth);
    expect(options.body).toMatchObject({
      available: true,
      autoCharge: true,
      cardOnFileAvailable: true,
      savedCard: { last4: '0003', brand: 'visa', expMonth: 12, expYear: 2029 },
    });

    const service = app.get(PlatformRedsysService);
    // Aún no vence: no cobra.
    expect(await service.runAutoCharges()).toEqual({ charged: 0, failed: 0 });

    await makeDue(owner.tenantId);
    const run = await service.runAutoCharges();
    expect(run.charged).toBeGreaterThanOrEqual(1);
    const payments = await admin.tenantSubscriptionPayment.findMany({
      where: { tenantId: owner.tenantId, provider: 'redsys' },
      orderBy: { createdAt: 'asc' },
    });
    expect(payments).toHaveLength(2);
    expect(payments[1]!.description).toMatch(/Cobro automático/);
    const after = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());

    // Desactivar: vuelve a pago a mano y se borra la tarjeta.
    await http().delete('/settings/saas-billing/redsys/card').set(auth).expect(204);
    const manual = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(manual.billingMode).toBe('manual');
    expect(await admin.platformRedsysCard.count({ where: { tenantId: owner.tenantId } })).toBe(0);
  });

  it('tarjeta rechazada: reintenta cada 2 días hasta 3 veces y avisa al super admin', async () => {
    await enableCardOnFile();
    const owner = await registerVerifiedUser(app, 'platredsysdecline');
    await payAndSaveCard(owner.accessToken, 'stub-decline-card');
    await makeDue(owner.tenantId);
    const service = app.get(PlatformRedsysService);

    await service.runAutoCharges();
    const card = await admin.platformRedsysCard.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(card.lastError).toMatch(/Denegada/);
    // Sin esperar 2 días no reintenta.
    await service.runAutoCharges();
    const auto = () =>
      admin.platformRedsysOrder.count({ where: { tenantId: owner.tenantId, kind: 'auto' } });
    expect(await auto()).toBe(1);

    for (let i = 0; i < 3; i++) {
      await admin.platformRedsysOrder.updateMany({
        where: { tenantId: owner.tenantId, kind: 'auto' },
        data: { createdAt: new Date(Date.now() - 3 * 86_400_000) },
      });
      await service.runAutoCharges();
    }
    expect(await auto()).toBe(3);
    const note = await admin.superAdminNotification.findFirst({
      where: { type: 'platform_redsys.auto_charge_failed', link: { contains: owner.tenantId } },
    });
    expect(note).toBeTruthy();
    expect(
      await admin.tenantSubscriptionPayment.count({
        where: {
          tenantId: owner.tenantId,
          provider: 'redsys',
          description: { contains: 'automático' },
        },
      }),
    ).toBe(0);
  });

  it('sin respuesta del banco: queda en curso y el aviso de Redsys lo registra una vez', async () => {
    await enableCardOnFile();
    const owner = await registerVerifiedUser(app, 'platredsysnoresp');
    await payAndSaveCard(owner.accessToken, 'stub-noresponse-card');
    await makeDue(owner.tenantId);
    const service = app.get(PlatformRedsysService);
    await service.runAutoCharges();
    const charging = await admin.platformRedsysOrder.findFirstOrThrow({
      where: { tenantId: owner.tenantId, kind: 'auto' },
    });
    expect(charging.status).toBe('charging');
    // Con un cobro en curso no se intenta otro.
    await service.runAutoCharges();
    expect(
      await admin.platformRedsysOrder.count({ where: { tenantId: owner.tenantId, kind: 'auto' } }),
    ).toBe(1);

    const mp = encodeMerchantParameters({ Ds_Order: charging.order, Ds_Response: '0000' });
    const signed = {
      Ds_MerchantParameters: mp,
      Ds_Signature: signRequest(mp, charging.order, TEST_KEY),
    };
    await http().post('/webhooks/redsys/platform').send(signed).expect(200);
    await http().post('/webhooks/redsys/platform').send(signed).expect(200);
    expect(
      await admin.tenantSubscriptionPayment.count({
        where: {
          tenantId: owner.tenantId,
          provider: 'redsys',
          description: { contains: 'automático' },
        },
      }),
    ).toBe(1);
  });

  it('sin sesión no hay acceso', async () => {
    await http().get('/admin/platform-redsys/settings').expect(401);
    await http().get('/settings/saas-billing/redsys').expect(401);
  });
});
