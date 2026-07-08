import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Cierre de caja diario: agrega los cobros del día por método y cuadra el
 * efectivo contado contra lo registrado.
 */
describe('Cierre de caja (arqueo) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('resume el efectivo del día y cierra la caja con la diferencia', async () => {
    const owner = await registerVerifiedUser(app, 'cash');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    // Emite y cobra en EFECTIVO una factura hoy (mark-paid crea el payment).
    const inv = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    await request(app.getHttpServer()).post(`/invoices/${inv}/issue`).set(auth).expect(200);
    await request(app.getHttpServer())
      .post(`/invoices/${inv}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    const today = new Date().toISOString().slice(0, 10);

    // El resumen del día refleja 121 € en efectivo, sin cierre aún.
    const summary = await request(app.getHttpServer()).get(`/cash/summary?date=${today}`).set(auth);
    expect(summary.status).toBe(200);
    expect(summary.body.cash).toBe(121);
    expect(summary.body.total).toBe(121);
    expect(summary.body.closure).toBeNull();

    // Cierra la caja habiendo contado 120 € → diferencia -1 (falta 1 €).
    const close = await request(app.getHttpServer())
      .post('/cash/close')
      .set(auth)
      .send({ date: today, countedCash: 120, notes: 'Falta cambio' });
    expect(close.status).toBe(201);
    expect(close.body.expectedCash).toBe(121);
    expect(close.body.countedCash).toBe(120);
    expect(close.body.difference).toBe(-1);

    // Segundo cierre del mismo día → 409.
    const again = await request(app.getHttpServer())
      .post('/cash/close')
      .set(auth)
      .send({ date: today, countedCash: 121 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('day_already_closed');

    // El resumen ya trae el cierre + aparece en el historial.
    const summary2 = await request(app.getHttpServer())
      .get(`/cash/summary?date=${today}`)
      .set(auth);
    expect(summary2.body.closure.difference).toBe(-1);
    const closures = await request(app.getHttpServer()).get('/cash/closures').set(auth);
    expect((closures.body as { date: string }[]).some((c) => c.date === today)).toBe(true);
  });
});
