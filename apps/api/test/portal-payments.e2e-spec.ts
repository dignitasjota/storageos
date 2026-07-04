import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Self-service de pagos del portal (Fase SEPA). Sin claves Stripe en test,
 * estos specs cubren la capa de seguridad: auth por JWT de portal,
 * propiedad de la invoice y el camino 400 `no_payment_method` (que no
 * llega al gateway). El happy path con Stripe se valida a mano en test
 * mode (DEPLOYMENT.md 12B).
 */
describe('Portal payments self-service (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function portalLogin(slug: string, email: string): Promise<string> {
    const req = await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email });
    expect(req.status).toBe(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const tokenMatch = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/);
    expect(tokenMatch).toBeTruthy();
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token: tokenMatch![1] });
    expect(consume.status).toBe(200);
    return consume.body.accessToken as string;
  }

  it('los endpoints de pago exigen token de portal (401 sin token y con token invalido)', async () => {
    const server = app.getHttpServer();
    const cases = [
      () => request(server).get('/portal/me/payment-methods'),
      () => request(server).post('/portal/me/payment-methods/setup-intent'),
      () => request(server).post('/portal/me/payment-methods').send({ gatewayToken: 'pm_x' }),
      () => request(server).post('/portal/me/invoices/019e3d20-aaaa-7c2f-bf37-6511065b9fc5/charge'),
    ];
    for (const make of cases) {
      const sinToken = await make();
      expect(sinToken.status).toBe(401);
      const tokenInvalido = await make().set('Authorization', 'Bearer no-es-un-jwt');
      expect(tokenInvalido.status).toBe(401);
    }
  });

  it('GET /portal/me/payment-methods devuelve [] para un customer sin metodos', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pm-empty');
    const email = `cli-${Date.now().toString(36)}@portal.local`;
    await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);

    const res = await request(app.getHttpServer())
      .get('/portal/me/payment-methods')
      .set('Authorization', `Bearer ${portalToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('charge de una invoice de OTRO customer del mismo tenant devuelve 404', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pm-cross');
    // Customer A: dueño de la factura.
    const emailA = `cli-a-${Date.now().toString(36)}@portal.local`;
    const customerA = await createCustomer(app, owner.accessToken, { email: emailA });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerA, {
      unitPrice: 40,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    // Customer B: intenta pagar la factura de A con su propio token.
    const emailB = `cli-b-${Date.now().toString(36)}@portal.local`;
    await createCustomer(app, owner.accessToken, { email: emailB });
    const tokenB = await portalLogin(owner.slug, emailB);

    const res = await request(app.getHttpServer())
      .post(`/portal/me/invoices/${invoiceId}/charge`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('invoice_not_found');
  });

  it('charge de invoice propia sin metodo de pago devuelve 400 no_payment_method', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pm-nopm');
    const email = `cli-${Date.now().toString(36)}@portal.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 25,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const portalToken = await portalLogin(owner.slug, email);

    const res = await request(app.getHttpServer())
      .post(`/portal/me/invoices/${invoiceId}/charge`)
      .set('Authorization', `Bearer ${portalToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_payment_method');
  });

  it('con un cobro en curso (processing) el charge da 409 y la factura sale marcada', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pm-inflight');
    const email = `cli-${Date.now().toString(36)}@portal.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 30,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    // Simula un adeudo SEPA en curso sobre la factura.
    await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId,
        customerId,
        amount: 30,
        currency: 'EUR',
        status: 'processing',
        methodType: 'sepa_debit',
        gateway: 'stripe',
      },
    });

    const portalToken = await portalLogin(owner.slug, email);

    // El segundo intento de cobro se bloquea (evita el doble adeudo).
    const charge = await request(app.getHttpServer())
      .post(`/portal/me/invoices/${invoiceId}/charge`)
      .set('Authorization', `Bearer ${portalToken}`);
    expect(charge.status).toBe(409);
    expect(charge.body.code).toBe('payment_in_progress');

    // La factura se expone al portal con la bandera de pago en curso.
    const list = await request(app.getHttpServer())
      .get('/portal/me/invoices')
      .set('Authorization', `Bearer ${portalToken}`);
    const row = list.body.find((i: { id: string }) => i.id === invoiceId);
    expect(row.paymentInProgress).toBe(true);
  });
});
