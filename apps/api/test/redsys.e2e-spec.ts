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

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
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
      .set('Authorization', `Bearer ${owner.accessToken}`);
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
      .set('Authorization', `Bearer ${owner.accessToken}`);
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
});
