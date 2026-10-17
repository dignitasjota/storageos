import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import {
  encodeMerchantParameters,
  signRequest,
} from '../src/modules/payments/redsys/redsys-signature';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

/**
 * Redsys con pago por referencia: el primer pago guarda la tarjeta y las
 * cuotas siguientes se cobran solas (Redsys simulado en test).
 */
describe('Redsys: tarjeta guardada y cobro automático (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('guarda la tarjeta en el primer pago y cobra la siguiente factura con ella', async () => {
    const owner = await registerVerifiedUser(app, 'redsyscof');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    await http()
      .put('/settings/redsys')
      .set(auth)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: TEST_KEY,
        environment: 'test',
        enabled: true,
        cardOnFileEnabled: true,
      })
      .expect(200);

    const customerId = await createCustomer(app, owner.accessToken);
    const first = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${first}/issue`).set(auth).expect(200);

    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await http().post('/portal/login/consume').send({ token });
    const portal = { Authorization: `Bearer ${consume.body.accessToken}` };

    const avail = await http().get('/portal/me/redsys/enabled').set(portal).expect(200);
    expect(avail.body.cardOnFileEnabled).toBe(true);

    // El inquilino paga con tarjeta y acepta guardarla.
    const redirect = await http()
      .post(`/portal/me/invoices/${first}/redsys-redirect`)
      .set(portal)
      .send({ payMethod: 'card', saveCard: true })
      .expect(200);
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    ) as Record<string, string>;
    expect(params).toMatchObject({
      DS_MERCHANT_IDENTIFIER: 'REQUIRED',
      DS_MERCHANT_COF_INI: 'S',
      DS_MERCHANT_COF_TYPE: 'R',
      DS_MERCHANT_PAYMETHODS: 'C',
    });

    // Redsys confirma el pago y devuelve la referencia de la tarjeta.
    const order = params.DS_MERCHANT_ORDER!;
    const notif = encodeMerchantParameters({
      Ds_Order: order,
      Ds_Response: '0000',
      Ds_Amount: params.DS_MERCHANT_AMOUNT!,
      Ds_Merchant_Identifier: 'ref-tarjeta-123',
      Ds_Merchant_Cof_Txnid: '2310151234567',
      Ds_Card_Number: '454881******0004',
      Ds_ExpiryDate: '2912',
      Ds_Card_Brand: '1',
    });
    await http()
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: notif,
        Ds_Signature: signRequest(notif, order, TEST_KEY),
      })
      .expect(200);
    expect((await http().get(`/invoices/${first}`).set(auth)).body.status).toBe('paid');

    const pms = await http().get(`/customers/${customerId}/payment-methods`).set(auth).expect(200);
    expect(pms.body).toHaveLength(1);
    expect(pms.body[0]).toMatchObject({
      gateway: 'redsys',
      type: 'card',
      last4: '0004',
      brand: 'visa',
      expMonth: 12,
      expYear: 2029,
      isDefault: true,
    });
    const saved = await admin.paymentMethod.findFirstOrThrow({ where: { customerId } });
    expect(saved.networkTxnId).toBe('2310151234567');

    // Siguiente cuota: se cobra con la tarjeta guardada, sin el inquilino.
    const second = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${second}/issue`).set(auth).expect(200);
    const charge = await http().post(`/payments/invoices/${second}/charge`).set(auth).send({});
    expect(charge.status).toBe(200);
    expect(charge.body).toMatchObject({ status: 'succeeded', gateway: 'redsys' });
    expect((await http().get(`/invoices/${second}`).set(auth)).body.status).toBe('paid');
    // Queda la orden de Redsys cerrada: una notificación posterior no cobra dos veces.
    const mitOrder = await admin.redsysOrder.findFirstOrThrow({ where: { invoiceId: second } });
    expect(mitOrder.status).toBe('paid');
    const lateNotif = encodeMerchantParameters({
      Ds_Order: mitOrder.order,
      Ds_Response: '0000',
      Ds_Amount: String(mitOrder.amountCents),
    });
    await http()
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: lateNotif,
        Ds_Signature: signRequest(lateNotif, mitOrder.order, TEST_KEY),
      })
      .expect(200);
    expect(await admin.payment.count({ where: { invoiceId: second, status: 'succeeded' } })).toBe(
      1,
    );

    // Respuesta del banco perdida (orden `charging`): la notificación la aplica.
    const lostInv = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${lostInv}/issue`).set(auth).expect(200);
    const lostOrder = `9${Date.now().toString().slice(-11)}`;
    await admin.redsysOrder.create({
      data: {
        order: lostOrder,
        tenantId: owner.tenantId,
        invoiceId: lostInv,
        amountCents: 6050,
        status: 'charging',
      },
    });
    const lostNotif = encodeMerchantParameters({
      Ds_Order: lostOrder,
      Ds_Response: '0000',
      Ds_Amount: '6050',
    });
    await http()
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: lostNotif,
        Ds_Signature: signRequest(lostNotif, lostOrder, TEST_KEY),
      })
      .expect(200);
    expect((await http().get(`/invoices/${lostInv}`).set(auth)).body.status).toBe('paid');

    // Si el banco la rechaza, el cobro queda fallido y la factura pendiente.
    await admin.paymentMethod.update({
      where: { id: saved.id },
      data: { gatewayTokenEncrypted: await encryptForTenant(owner.tenantId, 'stub-decline-1') },
    });
    const third = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${third}/issue`).set(auth).expect(200);
    const declined = await http().post(`/payments/invoices/${third}/charge`).set(auth).send({});
    expect(declined.body.status).toBe('failed');
    expect((await http().get(`/invoices/${third}`).set(auth)).body.status).toBe('issued');

    // El banco no contesta: el pago queda en curso (no se puede cobrar otra vez)
    // y la notificación posterior lo aplica sin crear un segundo pago.
    await admin.paymentMethod.update({
      where: { id: saved.id },
      data: { gatewayTokenEncrypted: await encryptForTenant(owner.tenantId, 'stub-noresponse-1') },
    });
    const fourth = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${fourth}/issue`).set(auth).expect(200);
    const silent = await http().post(`/payments/invoices/${fourth}/charge`).set(auth).send({});
    expect(silent.body.status).toBe('processing');
    await http().post(`/payments/invoices/${fourth}/charge`).set(auth).send({}).expect(409);
    const silentOrder = await admin.redsysOrder.findFirstOrThrow({
      where: { invoiceId: fourth, status: 'charging' },
    });
    const silentNotif = encodeMerchantParameters({
      Ds_Order: silentOrder.order,
      Ds_Response: '0000',
      Ds_Amount: String(silentOrder.amountCents),
    });
    await http()
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: silentNotif,
        Ds_Signature: signRequest(silentNotif, silentOrder.order, TEST_KEY),
      })
      .expect(200);
    expect((await http().get(`/invoices/${fourth}`).set(auth)).body.status).toBe('paid');
    expect(await admin.payment.count({ where: { invoiceId: fourth } })).toBe(1);

    // Sin notificación en 24 h: la orden caduca, el pago queda fallido y la
    // factura se puede volver a cobrar.
    const fifth = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${fifth}/issue`).set(auth).expect(200);
    await http().post(`/payments/invoices/${fifth}/charge`).set(auth).send({}).expect(200);
    const staleOrder = await admin.redsysOrder.findFirstOrThrow({
      where: { invoiceId: fifth, status: 'charging' },
    });
    await admin.redsysOrder.update({
      where: { order: staleOrder.order },
      data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    const { StaleChargesService } = await import('../src/modules/payments/stale-charges.service');
    await app.get(StaleChargesService, { strict: false }).run();
    expect(
      (await admin.redsysOrder.findUniqueOrThrow({ where: { order: staleOrder.order } })).status,
    ).toBe('expired');
    expect((await admin.payment.findFirstOrThrow({ where: { invoiceId: fifth } })).status).toBe(
      'failed',
    );
    await admin.paymentMethod.update({
      where: { id: saved.id },
      data: { gatewayTokenEncrypted: await encryptForTenant(owner.tenantId, 'ref-tarjeta-123') },
    });
    const again = await http().post(`/payments/invoices/${fifth}/charge`).set(auth).send({});
    expect(again.body.status).toBe('succeeded');
  });

  it('sin pago por referencia activado no se pide guardar la tarjeta', async () => {
    const owner = await registerVerifiedUser(app, 'redsysnocof');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .put('/settings/redsys')
      .set(auth)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: TEST_KEY,
        environment: 'test',
        enabled: true,
      })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken);
    const inv = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${inv}/issue`).set(auth).expect(200);
    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    const redirect = await request(app.getHttpServer())
      .post(`/portal/me/invoices/${inv}/redsys-redirect`)
      .set({ Authorization: `Bearer ${consume.body.accessToken}` })
      .send({ payMethod: 'card', saveCard: true })
      .expect(200);
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    ) as Record<string, string>;
    expect(params.DS_MERCHANT_IDENTIFIER).toBeUndefined();
  });

  async function encryptForTenant(tenantId: string, value: string): Promise<string> {
    const { CryptoService } = await import('../src/common/crypto/crypto.service');
    return app.get(CryptoService, { strict: false }).encryptString(value, tenantId);
  }
});
