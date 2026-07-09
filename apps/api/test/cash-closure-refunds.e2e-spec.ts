import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Arqueo de caja: un reembolso en efectivo resta del efectivo esperado del día.
 */
describe('Cierre de caja: reembolsos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un reembolso en efectivo baja el efectivo esperado', async () => {
    const owner = await registerVerifiedUser(app, 'cashrefund');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const today = new Date().toISOString().slice(0, 10);
    const customerId = await createCustomer(app, owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);

    // Factura emitida y cobrada en efectivo (121 = 100 + 21% IVA).
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(auth)
      .expect((r) => [200, 201].includes(r.status));
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect((r) => [200, 201].includes(r.status));

    const before = await request(app.getHttpServer()).get(`/cash/summary?date=${today}`).set(auth);
    expect(before.body.cash).toBe(121);
    expect(before.body.cashRefunds).toBe(0);
    expect(before.body.expectedCash).toBe(121);

    // Reembolso parcial en efectivo de 30 €.
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/refund`)
      .set(auth)
      .send({ amount: 30, reason: 'Devolución en caja' })
      .expect((r) => [200, 201].includes(r.status));

    const after = await request(app.getHttpServer()).get(`/cash/summary?date=${today}`).set(auth);
    // El ingreso del día sigue contando (el efectivo entró), y el reembolso resta.
    expect(after.body.cash).toBe(121);
    expect(after.body.cashRefunds).toBe(30);
    expect(after.body.expectedCash).toBe(91);
  });
});
