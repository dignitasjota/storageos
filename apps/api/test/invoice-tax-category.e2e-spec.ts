import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Tipo fiscal de cada línea: con IVA, exenta (p. ej. alquiler de vivienda) o
 * no sujeta (fianza). Se guarda, se conserva al anular y los informes lo separan.
 */
describe('Facturas con líneas exentas y no sujetas (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let customerId: string;
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    const owner = await registerVerifiedUser(app, 'taxcategory');
    token = owner.accessToken;
    customerId = await createCustomer(app, token);
    await ensureDefaultSeries(app, token);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('guarda el tipo fiscal, lo conserva al anular y los informes lo separan', async () => {
    const created = await http()
      .post('/invoices')
      .set(auth())
      .send({
        customerId,
        items: [
          { description: 'Trastero', quantity: 1, unitPrice: 100, taxRate: 21 },
          {
            description: 'Alquiler de vivienda',
            quantity: 1,
            unitPrice: 700,
            taxRate: 0,
            taxCategory: 'E1',
          },
          // Sin indicar, al 0 % queda como no sujeta (como hasta ahora).
          { description: 'Fianza', quantity: 1, unitPrice: 50, taxRate: 0 },
        ],
      });
    expect(created.status).toBe(201);
    const byDesc = (d: string) =>
      (created.body.items as { description: string; taxCategory: string }[]).find(
        (i) => i.description === d,
      )!;
    expect(byDesc('Trastero').taxCategory).toBe('S1');
    expect(byDesc('Alquiler de vivienda').taxCategory).toBe('E1');
    expect(byDesc('Fianza').taxCategory).toBe('N1');
    expect(created.body.total).toBe(871);

    await http().post(`/invoices/${created.body.id}/issue`).set(auth()).expect(200);

    const today = new Date().toISOString().slice(0, 10);
    const book = await http().get(`/fiscal/vat-book?from=${today}&to=${today}`).set(auth());
    expect(book.status).toBe(200);
    const groups = book.body.byRate as { rate: number; taxCategory: string; base: number }[];
    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rate: 21, taxCategory: 'S1', base: 100 }),
        expect.objectContaining({ rate: 0, taxCategory: 'E1', base: 700 }),
        expect.objectContaining({ rate: 0, taxCategory: 'N1', base: 50 }),
      ]),
    );

    const exp = await http().get(`/fiscal/accounting-export?from=${today}&to=${today}`).set(auth());
    expect(
      (exp.body.rows as { taxCategory: string; base: number }[]).find((r) => r.taxCategory === 'E1')
        ?.base,
    ).toBe(700);

    // Anular la emitida: la rectificativa de abono conserva el tipo fiscal.
    const cancelled = await http()
      .post(`/invoices/${created.body.id}/cancel`)
      .set(auth())
      .send({ reason: 'Error' });
    expect(cancelled.status).toBe(200);
    const rectId = cancelled.body.rectifiedBy[0].id as string;
    const rect = await http().get(`/invoices/${rectId}`).set(auth());
    const rectCats = (rect.body.items as { description: string; taxCategory: string }[]).map(
      (i) => `${i.description}:${i.taxCategory}`,
    );
    expect(rectCats).toEqual(
      expect.arrayContaining(['Trastero:S1', 'Alquiler de vivienda:E1', 'Fianza:N1']),
    );
  });

  it('una línea exenta o no sujeta no puede llevar IVA', async () => {
    const res = await http()
      .post('/invoices')
      .set(auth())
      .send({
        customerId,
        items: [
          { description: 'Vivienda', quantity: 1, unitPrice: 700, taxRate: 21, taxCategory: 'E1' },
        ],
      });
    expect(res.status).toBe(400);
  });
});
