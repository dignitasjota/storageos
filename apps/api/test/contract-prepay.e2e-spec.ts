import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Prepago anual/semestral con descuento: un contrato con `billingIntervalMonths`
 * >1 se factura de una vez por N meses (cuota × N × (1−descuento)); la recurrente
 * NO vuelve a facturar mientras el periodo esté cubierto y emite el siguiente
 * periodo al vencer la cobertura.
 */
describe('Prepago anual/semestral del inquilino (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('contrato anual: la recurrente emite 12 meses con descuento, no duplica y renueva al vencer', async () => {
    const owner = await registerVerifiedUser(app, 'prepay');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Prep', lastName: 'Ago', country: 'ES' });

    // Contrato ANUAL: cuota 100 €, prepago 12 meses con 10% de descuento.
    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId: customer.body.id,
      unitId: unitIds[0],
      startDate: '2026-01-10',
      priceMonthly: 100,
      billingIntervalMonths: 12,
      prepayDiscountPct: 10,
      depositAmount: 0,
    });
    expect(contract.status).toBe(201);
    expect(contract.body.billingIntervalMonths).toBe(12);
    expect(contract.body.prepayDiscountPct).toBe(10);
    const contractId = contract.body.id as string;

    // Firmar → contrato activo (la recurrente solo factura active/ending).
    await request(app.getHttpServer())
      .post(`/contracts/${contractId}/sign`)
      .set(auth)
      .send({})
      .expect(200);

    const billing = app.get(BillingJobsService);

    // Recurrente de ENERO 2026 → emite UNA factura de 12 meses.
    const jan = await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    });
    expect(jan.created).toBe(1);

    const afterJan = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    const invs1 = afterJan.body.items ?? afterJan.body;
    expect(invs1.length).toBe(1);
    const first = await request(app.getHttpServer()).get(`/invoices/${invs1[0].id}`).set(auth);
    const rent = (first.body.items as { description: string; unitPrice: number }[]).find((i) =>
      i.description.toLowerCase().includes('alquiler'),
    );
    // 100 € × 12 meses × 0.9 = 1080 €.
    expect(rent!.unitPrice).toBe(1080);
    expect(first.body.items[0].periodStart.slice(0, 10)).toBe('2026-01-10');
    expect(first.body.items[0].periodEnd.slice(0, 10)).toBe('2027-01-09');

    // Recurrente de FEBRERO 2026 → NO factura (cobertura anual vigente).
    const feb = await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
    });
    expect(feb.created).toBe(0);
    const afterFeb = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    expect((afterFeb.body.items ?? afterFeb.body).length).toBe(1);

    // Recurrente de ENERO 2027 → renueva el prepago (siguiente periodo anual).
    const jan27 = await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2027-01-01',
      periodEnd: '2027-01-31',
    });
    expect(jan27.created).toBe(1);
    const afterJan27 = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    const invs2 = afterJan27.body.items ?? afterJan27.body;
    expect(invs2.length).toBe(2);
  });
});
