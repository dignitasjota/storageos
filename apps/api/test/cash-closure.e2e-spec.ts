import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
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

  it('la caja por local es independiente de la global', async () => {
    const owner = await registerVerifiedUser(app, 'cashfac');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    // Contrato en el local → factura → cobro en efectivo (queda anclado al local).
    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    const inv = await request(app.getHttpServer())
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: contract.body.id,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 50, taxRate: 0 }],
      });
    await request(app.getHttpServer()).post(`/invoices/${inv.body.id}/issue`).set(auth).expect(200);
    await request(app.getHttpServer())
      .post(`/invoices/${inv.body.id}/mark-paid`)
      .set(auth)
      .send({ amount: 50, methodType: 'cash' })
      .expect(200);

    const today = new Date().toISOString().slice(0, 10);

    // El resumen del LOCAL refleja los 50 € de efectivo de ese local.
    const facSummary = await request(app.getHttpServer())
      .get(`/cash/summary?date=${today}&facilityId=${facilityId}`)
      .set(auth);
    expect(facSummary.body.facilityId).toBe(facilityId);
    expect(facSummary.body.cash).toBe(50);

    // Cierro la caja del LOCAL.
    const closeFac = await request(app.getHttpServer())
      .post('/cash/close')
      .set(auth)
      .send({ date: today, countedCash: 50, facilityId });
    expect(closeFac.status).toBe(201);
    expect(closeFac.body.facilityId).toBe(facilityId);

    // La caja GLOBAL del mismo día sigue abierta (índice parcial): puedo cerrarla.
    const closeGlobal = await request(app.getHttpServer())
      .post('/cash/close')
      .set(auth)
      .send({ date: today, countedCash: 50 });
    expect(closeGlobal.status).toBe(201);
    expect(closeGlobal.body.facilityId).toBeNull();

    // Re-cerrar el local → 409.
    const again = await request(app.getHttpServer())
      .post('/cash/close')
      .set(auth)
      .send({ date: today, countedCash: 50, facilityId });
    expect(again.status).toBe(409);
  });
});
