import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { setTenantPlan } from './helpers/tenant-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Política de subidas de precio (ECRI): tope de % anual (cap) + meses mínimos
 * entre subidas. Aquí se cubre el cap del %.
 */
describe('Política de subidas de precio (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('el tope anual limita el % de la subida', async () => {
    const owner = await registerVerifiedUser(app, 'rentpolicy');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // La feature `rent_increases` está en starter, pero por si acaso subimos a pro.
    await setTenantPlan(owner.slug, 'pro');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Contrato firmado (active, con signedAt) a 30 €.
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 30 });
    expect(contract.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .expect((r) => [200, 201].includes(r.status));

    // Política: tope del 5% anual.
    const patch = await request(app.getHttpServer())
      .patch('/rent-increases/policy')
      .set(auth)
      .send({ maxAnnualPct: 5, minMonthsBetween: 12 });
    expect(patch.status).toBe(200);
    expect(patch.body.maxAnnualPct).toBe(5);

    // Preview de una subida del 10% → se capa al 5% (30 → 31.5, no 33).
    const preview = await request(app.getHttpServer())
      .post('/rent-increases/preview')
      .set(auth)
      .send({
        increaseType: 'percentage',
        increaseValue: 10,
        scope: { minMonthsSinceSigned: 0 },
      });
    expect(preview.status).toBe(200);
    const affected = preview.body.contracts.find(
      (c: { contractId: string }) => c.contractId === contract.body.id,
    );
    expect(affected).toBeTruthy();
    expect(affected.oldPrice).toBe(30);
    expect(affected.newPrice).toBe(31.5); // +5% (capado), no +10%
  });
});
