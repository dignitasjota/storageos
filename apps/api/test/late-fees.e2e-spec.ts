import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Late fees / recargos por mora (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('configura el recargo y lo aplica como factura separada (idempotente)', async () => {
    const owner = await registerVerifiedUser(app, 'latefee');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Configurar recargo: 5% del importe vencido.
    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ lateFeeEnabled: true, lateFeeType: 'percentage', lateFeeValue: 5 });
    expect(patch.status).toBe(200);
    expect(patch.body.lateFeeEnabled).toBe(true);

    const get = await request(app.getHttpServer()).get('/settings/tenant/billing').set(auth);
    expect(get.body.lateFeeEnabled).toBe(true);
    expect(get.body.lateFeeType).toBe('percentage');
    expect(get.body.lateFeeValue).toBe(5);

    // Factura emitida de 100 + 21% IVA = 121 €.
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(auth);
    expect(issued.status).toBe(200);
    expect(issued.body.total).toBe(121);

    // Aplicar recargo → factura nueva de 6.05 € (5% de 121, sin IVA).
    const lateFee = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/late-fee`)
      .set(auth);
    expect(lateFee.status).toBe(200);
    expect(lateFee.body.status).toBe('issued');
    expect(lateFee.body.lateFeeForInvoiceId).toBe(invoiceId);
    expect(lateFee.body.total).toBe(6.05);
    expect(lateFee.body.items[0].description).toContain('Recargo por mora');

    // La factura original enlaza al recargo.
    const original = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(original.body.lateFeeInvoiceId).toBe(lateFee.body.id);

    // Reaplicar → 409 (idempotente, una sola por factura).
    const again = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/late-fee`)
      .set(auth);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('late_fee_already_applied');
  });
});
