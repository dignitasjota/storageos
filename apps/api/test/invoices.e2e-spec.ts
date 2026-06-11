import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  createDraftInvoice,
  ensureDefaultSeries,
  waitForAeatStatus,
} from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Invoices state machine + Verifactu hash (e2e)', () => {
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

  it('crea draft con totales calculados correctos', async () => {
    const owner = await registerVerifiedUser(app, 'inv-create');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
      quantity: 2,
    });
    const detail = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('draft');
    expect(detail.body.subtotal).toBe(200);
    expect(detail.body.taxAmount).toBeCloseTo(42, 1);
    expect(detail.body.total).toBeCloseTo(242, 1);
    expect(detail.body.hash).toBeNull();
  });

  it('issue asigna numero + hash + previousHash encadenado entre dos facturas', async () => {
    const owner = await registerVerifiedUser(app, 'inv-issue');
    const customerId = await createCustomer(app, owner.accessToken);
    const id1 = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    const issued1 = await request(app.getHttpServer())
      .post(`/invoices/${id1}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issued1.status).toBe(200);
    expect(issued1.body.status).toBe('issued');
    expect(issued1.body.invoiceNumber).toMatch(/^FA\/\d{4}\/00001$/);
    expect(issued1.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued1.body.previousHash).toBeNull();
    expect(issued1.body.qrCodeUrl).toMatch(/^data:image\/png/);
    // El envio AEAT es asincrono (cola BullMQ `verifactu`): el body del issue
    // puede traer `pending`. Polling hasta que el processor lo resuelva.
    expect(await waitForAeatStatus(app, owner.accessToken, id1)).toBe('accepted');

    const id2 = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 75,
    });
    const issued2 = await request(app.getHttpServer())
      .post(`/invoices/${id2}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issued2.status).toBe(200);
    expect(issued2.body.invoiceNumber).toMatch(/^FA\/\d{4}\/00002$/);
    expect(issued2.body.previousHash).toBe(issued1.body.hash);
    expect(issued2.body.hash).not.toBe(issued1.body.hash);
  });

  it('mark-paid suma amount_paid; al completar el total pasa a paid', async () => {
    const owner = await registerVerifiedUser(app, 'inv-paid');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    // Pago parcial.
    const partial = await request(app.getHttpServer())
      .post(`/invoices/${id}/mark-paid`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ amount: 50, methodType: 'cash' });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe('issued'); // sigue issued, no totalmente pagado
    expect(partial.body.amountPaid).toBe(50);
    // Pago restante.
    const full = await request(app.getHttpServer())
      .post(`/invoices/${id}/mark-paid`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ amount: 71, methodType: 'bank_transfer' });
    expect(full.body.status).toBe('paid');
    expect(full.body.amountPaid).toBe(121);
  });

  it('transicion invalida: paid -> issued devuelve 400', async () => {
    const owner = await registerVerifiedUser(app, 'inv-bad-trans');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const res = await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_invoice_transition');
  });

  it('refund parcial → partially_refunded; refund total → refunded', async () => {
    const owner = await registerVerifiedUser(app, 'inv-refund');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 200,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    await request(app.getHttpServer())
      .post(`/invoices/${id}/mark-paid`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ amount: 242, methodType: 'cash' });
    const partial = await request(app.getHttpServer())
      .post(`/invoices/${id}/refund`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ amount: 50, reason: 'descuento' });
    expect(partial.body.status).toBe('partially_refunded');
    const full = await request(app.getHttpServer())
      .post(`/invoices/${id}/refund`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ amount: 192 });
    expect(full.body.status).toBe('refunded');
  });

  it('series duplicate code -> 409', async () => {
    const owner = await registerVerifiedUser(app, 'inv-series-dup');
    await ensureDefaultSeries(app, owner.accessToken);
    const dup = await request(app.getHttpServer())
      .post('/invoice-series')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ code: 'A', name: 'Otra', prefix: 'BR' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('invoice_series_code_taken');
  });
});

describe('Portal magic link (e2e)', () => {
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

  it('request + consume + listar mis facturas', async () => {
    const owner = await registerVerifiedUser(app, 'portal-flow');
    const customerEmail = `cli-${Date.now().toString(36)}@portal.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email: customerEmail });
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 30 });
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    // Pedir magic link.
    const req1 = await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email: customerEmail });
    expect(req1.status).toBe(204);

    const { waitForEmail } = await import('./helpers/mailpit');
    const mail = await waitForEmail(customerEmail, { subjectIncludes: 'Accede' });
    const tokenMatch = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/);
    if (!tokenMatch?.[1])
      throw new Error(`Token portal no encontrado en email: ${mail.Text.slice(0, 200)}`);
    const token = tokenMatch[1];

    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    expect(consume.status).toBe(200);
    expect(consume.body.accessToken).toBeTruthy();
    expect(consume.body.customerId).toBe(customerId);

    const myInvoices = await request(app.getHttpServer())
      .get('/portal/me/invoices')
      .set('Authorization', `Bearer ${consume.body.accessToken}`);
    expect(myInvoices.status).toBe(200);
    expect(myInvoices.body).toHaveLength(1);
    expect(myInvoices.body[0].status).toBe('issued');

    // Token magic link single-use: re-consumir -> 401
    const replay = await request(app.getHttpServer()).post('/portal/login/consume').send({ token });
    expect(replay.status).toBe(401);
  });
});
