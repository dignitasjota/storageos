import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import {
  encodeMerchantParameters,
  signRequest,
} from '../src/modules/payments/redsys/redsys-signature';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

async function configureRedsys(app: INestApplication, token: string) {
  const res = await request(app.getHttpServer())
    .put('/settings/redsys')
    .set('Authorization', `Bearer ${token}`)
    .send({
      merchantCode: '999008881',
      terminal: '1',
      secretKey: TEST_KEY,
      environment: 'test',
      enabled: true,
    });
  if (res.status !== 200)
    throw new Error(`config failed ${res.status}: ${JSON.stringify(res.body)}`);
}

async function issuedInvoice(app: INestApplication, token: string): Promise<string> {
  const customerId = await createCustomer(app, token);
  const invoiceId = await createDraftInvoice(app, token, customerId, { unitPrice: 100 });
  const issue = await request(app.getHttpServer())
    .post(`/invoices/${invoiceId}/issue`)
    .set('Authorization', `Bearer ${token}`);
  if (issue.status !== 201 && issue.status !== 200) {
    throw new Error(`issue failed ${issue.status}: ${JSON.stringify(issue.body)}`);
  }
  return invoiceId;
}

describe('Redsys (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('settings: por defecto deshabilitado y sin clave', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-default');
    const res = await request(app.getHttpServer())
      .get('/settings/redsys')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, hasSecretKey: false });
  });

  it('settings: activar sin clave → 400', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-nokey');
    const res = await request(app.getHttpServer())
      .put('/settings/redsys')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ merchantCode: '999008881', terminal: '1', environment: 'test', enabled: true });
    expect(res.status).toBe(400);
  });

  it('redirect genera formulario firmado y la notificación válida marca pagada', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-pay');
    await configureRedsys(app, owner.accessToken);
    const invoiceId = await issuedInvoice(app, owner.accessToken);

    const redirect = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    expect(redirect.status).toBe(200);
    expect(redirect.body.url).toContain('redsys.es');
    expect(redirect.body.signature.length).toBeGreaterThan(20);

    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    );
    const order = params.DS_MERCHANT_ORDER as string;
    expect(params.DS_MERCHANT_AMOUNT).toBe('12100'); // 100 + 21% IVA

    // Simula la notificación servidor-a-servidor de Redsys (pago aprobado).
    const notif = encodeMerchantParameters({
      Ds_Order: order,
      Ds_Response: '0000',
      Ds_Amount: '12100',
    });
    const signature = signRequest(notif, order, TEST_KEY);
    const webhook = await request(app.getHttpServer()).post('/webhooks/redsys').send({
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_MerchantParameters: notif,
      Ds_Signature: signature,
    });
    expect(webhook.status).toBe(200);

    const detail = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.body.status).toBe('paid');
    const paymentsAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const pays1 = await request(app.getHttpServer())
      .get(`/payments?invoiceId=${invoiceId}`)
      .set(paymentsAuth);
    const countAfter1 = (pays1.body as unknown[]).length;

    // Idempotencia: Redsys reentrega notificaciones. La MISMA notificación otra
    // vez → order ya 'paid' → no crea un segundo Payment.
    const dup = await request(app.getHttpServer()).post('/webhooks/redsys').send({
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_MerchantParameters: notif,
      Ds_Signature: signature,
    });
    expect(dup.status).toBe(200);
    const pays2 = await request(app.getHttpServer())
      .get(`/payments?invoiceId=${invoiceId}`)
      .set(paymentsAuth);
    expect((pays2.body as unknown[]).length).toBe(countAfter1);
  });

  it('notificación con firma inválida NO marca pagada', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-badsig');
    await configureRedsys(app, owner.accessToken);
    const invoiceId = await issuedInvoice(app, owner.accessToken);

    const redirect = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    );
    const order = params.DS_MERCHANT_ORDER as string;

    const notif = encodeMerchantParameters({ Ds_Order: order, Ds_Response: '0000' });
    const webhook = await request(app.getHttpServer()).post('/webhooks/redsys').send({
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_MerchantParameters: notif,
      Ds_Signature: 'firmaInvalida==',
    });
    expect(webhook.status).toBe(200); // se acusa recibo pero no se procesa

    const detail = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.body.status).toBe('issued');
  });

  it('Bizum: sin activar → 400; activado → el redirect fuerza PAYMETHODS z', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-bizum');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await configureRedsys(app, owner.accessToken); // enabled, bizum off por defecto
    const invoiceId = await issuedInvoice(app, owner.accessToken);

    // Bizum desactivado → 400 bizum_not_enabled.
    const denied = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set(auth)
      .send({ payMethod: 'bizum' });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('bizum_not_enabled');

    // Activar Bizum.
    const upd = await request(app.getHttpServer()).put('/settings/redsys').set(auth).send({
      merchantCode: '999008881',
      terminal: '1',
      environment: 'test',
      enabled: true,
      bizumEnabled: true,
    });
    expect(upd.status).toBe(200);
    expect(upd.body.bizumEnabled).toBe(true);

    // Redirect con payMethod bizum → DS_MERCHANT_PAYMETHODS = 'z'.
    const redirect = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set(auth)
      .send({ payMethod: 'bizum' });
    expect(redirect.status).toBe(200);
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    );
    expect(params.DS_MERCHANT_PAYMETHODS).toBe('z');

    // Redirect con tarjeta → 'C'.
    const card = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set(auth)
      .send({ payMethod: 'card' });
    const cardParams = JSON.parse(
      Buffer.from(card.body.merchantParameters, 'base64').toString('utf8'),
    );
    expect(cardParams.DS_MERCHANT_PAYMETHODS).toBe('C');
  });

  it('doble clic (2 redirects seguidos, sin pagar) reutiliza la MISMA orden pendiente — no crea dos', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-doubleclick');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await configureRedsys(app, owner.accessToken);
    const invoiceId = await issuedInvoice(app, owner.accessToken);

    const first = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set(auth)
      .send({});
    const second = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set(auth)
      .send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const paramsA = JSON.parse(
      Buffer.from(first.body.merchantParameters, 'base64').toString('utf8'),
    );
    const paramsB = JSON.parse(
      Buffer.from(second.body.merchantParameters, 'base64').toString('utf8'),
    );
    expect(paramsB.DS_MERCHANT_ORDER).toBe(paramsA.DS_MERCHANT_ORDER);

    const orders = await admin.redsysOrder.findMany({ where: { invoiceId } });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe('pending');
  });

  it('condición de carrera: N redirects CONCURRENTES para la misma factura generan UNA sola orden pendiente', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-race');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await configureRedsys(app, owner.accessToken);
    const invoiceId = await issuedInvoice(app, owner.accessToken);

    const attempts = 6;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app.getHttpServer())
          .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
          .set(auth)
          .send({}),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const orderIds = new Set(
      responses.map((r) => {
        const params = JSON.parse(
          Buffer.from(r.body.merchantParameters, 'base64').toString('utf8'),
        );
        return params.DS_MERCHANT_ORDER as string;
      }),
    );
    // Todos los requests concurrentes deben resolver a la MISMA orden — antes
    // del fix, cada uno habría generado la suya (N filas `pending` distintas).
    expect(orderIds.size).toBe(1);

    const orders = await admin.redsysOrder.findMany({ where: { invoiceId } });
    expect(orders).toHaveLength(1);
  });

  it('un pago Redsys confirmado sobre una factura ya saldada por otra vía no se pierde: 200 + notificación al staff', async () => {
    const owner = await registerVerifiedUser(app, 'redsys-overpaid');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await configureRedsys(app, owner.accessToken);
    const invoiceId = await issuedInvoice(app, owner.accessToken);

    // El cliente abre el pago de Redsys (orden A, queda pending sin confirmar)...
    const redirect = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoiceId}/redirect`)
      .set(auth)
      .send({});
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    );
    const order = params.DS_MERCHANT_ORDER as string;

    // ...pero mientras tanto, el staff cobra la factura por OTRA vía (efectivo).
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    // Ahora el cliente termina de pagar la vieja pestaña de Redsys → notificación aprobada.
    const notif = encodeMerchantParameters({
      Ds_Order: order,
      Ds_Response: '0000',
      Ds_Amount: '12100',
    });
    const signature = signRequest(notif, order, TEST_KEY);
    const webhook = await request(app.getHttpServer()).post('/webhooks/redsys').send({
      Ds_SignatureVersion: 'HMAC_SHA256_V1',
      Ds_MerchantParameters: notif,
      Ds_Signature: signature,
    });
    // Redsys espera un ACK 200 pase lo que pase (si no, reintenta en bucle).
    expect(webhook.status).toBe(200);

    // La factura sigue pagada (el segundo cobro no se aplicó dos veces)...
    const detail = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(detail.body.status).toBe('paid');

    // ...pero el dinero de más NO se pierde en silencio: queda una notificación
    // accionable para que el staff lo reconcilie manualmente.
    const notifications = await request(app.getHttpServer()).get('/notifications').set(auth);
    expect(notifications.status).toBe(200);
    const found = notifications.body.items.find(
      (n: { type: string; link: string | null }) =>
        n.type === 'redsys.overpayment_needs_review' && n.link === `/invoices/${invoiceId}`,
    );
    expect(found).toBeTruthy();
  });
});
