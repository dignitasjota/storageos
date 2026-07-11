import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * «Sugerencias de hoy»: acciones concretas priorizadas cruzando las señales del
 * sistema (retención, precio, cobros, renovaciones). Determinista.
 */
describe('Sugerencias de hoy (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('tenant vacío → sin acciones; contrato que vence sin renovación → acción de renovación', async () => {
    const owner = await registerVerifiedUser(app, 'sugg');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Tenant sin datos → sin sugerencias.
    const empty = await request(app.getHttpServer()).get('/analytics/suggested-actions').set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.actions).toEqual([]);

    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    // Contrato que vence en 20 días SIN renovación automática.
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: isoDate(-300),
        endDate: isoDate(20),
        priceMonthly: 100,
        autoRenew: false,
      });
    expect(contract.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({})
      .expect(200);

    const res = await request(app.getHttpServer()).get('/analytics/suggested-actions').set(auth);
    expect(res.status).toBe(200);
    const renewal = (res.body.actions as { category: string; href: string; cta: string }[]).find(
      (a) => a.category === 'renewal',
    );
    expect(renewal).toBeDefined();
    expect(renewal!.href).toBe(`/contracts/${contract.body.id}`);
    expect(renewal!.cta).toBe('Ver contrato');
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/analytics/suggested-actions').expect(401);
  });
});
