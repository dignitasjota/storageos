import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Informes fiscales (libro IVA + 303 + 347) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('libro IVA, 303 y 347 a partir de las facturas emitidas', async () => {
    const owner = await registerVerifiedUser(app, 'fiscal');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    // Factura emitida de base 3000 € + 21% IVA = 3630 € (supera el umbral 347).
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 3000,
    });
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);

    const now = new Date();
    const year = now.getUTCFullYear();
    const quarter = Math.floor(now.getUTCMonth() / 3) + 1;

    // --- Libro de IVA emitido ---
    const book = await request(app.getHttpServer())
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(auth);
    expect(book.status).toBe(200);
    expect(book.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(book.body.totals.base).toBe(3000);
    expect(book.body.totals.vat).toBe(630);
    expect(book.body.totals.total).toBe(3630);
    expect(book.body.byRate.find((r: { rate: number }) => r.rate === 21)).toMatchObject({
      base: 3000,
      vat: 630,
    });

    // --- Modelo 303 (IVA devengado del trimestre) ---
    const m303 = await request(app.getHttpServer())
      .get(`/fiscal/model-303?year=${year}&quarter=${quarter}`)
      .set(auth);
    expect(m303.status).toBe(200);
    expect(m303.body.totalBase).toBe(3000);
    expect(m303.body.totalVat).toBe(630);
    expect(m303.body.byRate.find((r: { rate: number }) => r.rate === 21).vat).toBe(630);

    // --- Modelo 347 (cliente supera 3.005,06 €) ---
    const m347 = await request(app.getHttpServer()).get(`/fiscal/model-347?year=${year}`).set(auth);
    expect(m347.status).toBe(200);
    expect(m347.body.rows).toHaveLength(1);
    expect(m347.body.rows[0].total).toBe(3630);

    // Año sin facturas → 347 vacío.
    const empty = await request(app.getHttpServer())
      .get(`/fiscal/model-347?year=${year - 5}`)
      .set(auth);
    expect(empty.body.rows).toHaveLength(0);

    // Año inválido → 400.
    await request(app.getHttpServer()).get('/fiscal/model-347?year=abc').set(auth).expect(400);
  });
});
