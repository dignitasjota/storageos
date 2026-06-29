import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Insurance / protección recurrente (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('plan → contrato con seguro → línea en la factura recurrente; el snapshot no cambia', async () => {
    const owner = await registerVerifiedUser(app, 'insurance');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    // Crear plan de seguro.
    const plan = await request(app.getHttpServer())
      .post('/insurance-plans')
      .set(auth)
      .send({ name: 'Protección Básica', monthlyPrice: 5, coverageAmount: 3000, taxRate: 21 });
    expect(plan.status).toBe(201);
    expect(plan.body.monthlyPrice).toBe(5);
    const planId = plan.body.id as string;

    const list = await request(app.getHttpServer()).get('/insurance-plans').set(auth);
    expect(list.body).toHaveLength(1);

    // Contrato con seguro → congela la prima.
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-06-01',
      priceMonthly: 80,
      depositAmount: 0,
      insurancePlanId: planId,
    });
    expect(create.status).toBe(201);
    expect(create.body.insurancePlanId).toBe(planId);
    expect(create.body.insurancePrice).toBe(5);
    expect(create.body.insurancePlanName).toBe('Protección Básica');
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    // Subir la tarifa del plan NO cambia el snapshot del contrato.
    await request(app.getHttpServer())
      .patch(`/insurance-plans/${planId}`)
      .set(auth)
      .send({ monthlyPrice: 9 })
      .expect(200);
    const afterUpdate = await request(app.getHttpServer())
      .get(`/contracts/${contractId}`)
      .set(auth);
    expect(afterUpdate.body.insurancePrice).toBe(5);

    // Facturación recurrente: la factura del periodo incluye la línea de seguro.
    const billing = app.get(BillingJobsService);
    await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    });
    const invoices = await request(app.getHttpServer()).get('/invoices').set(auth);
    const invoice = invoices.body.find(
      (i: { contractId: string | null }) => i.contractId === contractId,
    );
    expect(invoice).toBeTruthy();
    const detail = await request(app.getHttpServer()).get(`/invoices/${invoice.id}`).set(auth);
    const descriptions = (detail.body.items as { description: string; unitPrice: number }[]).map(
      (it) => it.description,
    );
    const insuranceLine = (detail.body.items as { description: string; unitPrice: number }[]).find(
      (it) => it.description.includes('Protección'),
    );
    expect(descriptions.some((d) => d.startsWith('Alquiler'))).toBe(true);
    expect(insuranceLine).toBeTruthy();
    expect(insuranceLine!.unitPrice).toBe(5);

    // Quitar el seguro del contrato.
    const removed = await request(app.getHttpServer())
      .put(`/contracts/${contractId}/insurance`)
      .set(auth)
      .send({ planId: null });
    expect(removed.status).toBe(200);
    expect(removed.body.insurancePlanId).toBeNull();
    expect(removed.body.insurancePrice).toBeNull();
  });

  it('gating por plan: asignar seguro sin la feature `insurance` da 403 (quitar sigue permitido)', async () => {
    const owner = await registerVerifiedUser(app, 'insurance-gate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // En `starter` (con la feature): crear plan + contrato con seguro.
    const plan = await request(app.getHttpServer())
      .post('/insurance-plans')
      .set(auth)
      .send({ name: 'Básica', monthlyPrice: 5, coverageAmount: 3000, taxRate: 21 });
    expect(plan.status).toBe(201);
    const planId = plan.body.id as string;

    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-06-01',
      priceMonthly: 80,
      depositAmount: 0,
      insurancePlanId: planId,
    });
    expect(contract.status).toBe(201);
    const contractId = contract.body.id as string;

    // Downgrade a `free` (sin la feature `insurance`).
    await setTenantPlan(owner.slug, 'free');

    // Asignar/cambiar seguro vía el contrato → 403 feature_not_in_plan.
    const assign = await request(app.getHttpServer())
      .put(`/contracts/${contractId}/insurance`)
      .set(auth)
      .send({ planId });
    expect(assign.status).toBe(403);
    expect(assign.body.code).toBe('feature_not_in_plan');

    // Alta de OTRO contrato con seguro → también 403.
    const newWithInsurance = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[1],
      startDate: '2026-06-01',
      priceMonthly: 50,
      depositAmount: 0,
      insurancePlanId: planId,
    });
    expect(newWithInsurance.status).toBe(403);

    // Pero QUITAR el seguro (planId null) sigue permitido aunque no haya feature.
    const removed = await request(app.getHttpServer())
      .put(`/contracts/${contractId}/insurance`)
      .set(auth)
      .send({ planId: null });
    expect(removed.status).toBe(200);
    expect(removed.body.insurancePlanId).toBeNull();
  });
});
