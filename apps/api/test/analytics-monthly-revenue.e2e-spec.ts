import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Analytics: ingresos por mes (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('agrega facturado (emitido) y cobrado (pagado) del mes actual', async () => {
    const owner = await registerVerifiedUser(app, 'monthrev');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    // Factura emitida de 121 € (100 base + 21% IVA) y cobrada por completo.
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'bank_transfer' })
      .expect(200);

    const now = new Date();
    const curKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const res = await request(app.getHttpServer())
      .get('/analytics/monthly-revenue?months=6')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(6);
    const current = res.body.points.find((p: { yearMonth: string }) => p.yearMonth === curKey);
    expect(current).toBeDefined();
    expect(current.invoiced).toBe(121);
    expect(current.collected).toBe(121);
    // El mes anterior no tiene actividad.
    const prevIdx =
      res.body.points.findIndex((p: { yearMonth: string }) => p.yearMonth === curKey) - 1;
    if (prevIdx >= 0) {
      expect(res.body.points[prevIdx].invoiced).toBe(0);
      expect(res.body.points[prevIdx].collected).toBe(0);
    }

    // months clamp: 0 → default 12.
    const def = await request(app.getHttpServer())
      .get('/analytics/monthly-revenue?months=0')
      .set(auth);
    expect(def.body.points).toHaveLength(12);
  });
});
