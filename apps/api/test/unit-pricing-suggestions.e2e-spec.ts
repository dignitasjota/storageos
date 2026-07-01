import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Sugerencia de precio por trastero (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('sugiere precio por trastero según ocupación y lo aplica', async () => {
    const owner = await registerVerifiedUser(app, 'unitprice');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local UP', addressLine1: 'C/ T 1', city: 'Madrid', postalCode: '28001' });
    const facilityId = facility.body.id as string;
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Grande', defaultPriceMonthly: 100 });
    const unitTypeId = unitType.body.id as string;

    // Un solo trastero, disponible → ocupación 0% de su dimensión → sugerir bajar.
    const unit = await request(app.getHttpServer())
      .post('/units')
      .set(auth)
      .send({
        facilityId,
        unitTypeId,
        code: 'UP-001',
        widthM: 3,
        depthM: 3,
        heightM: 2.5,
        basePriceMonthly: 100,
      });
    const unitId = unit.body.id as string;

    const sug = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    expect(sug.status).toBe(200);
    const item = sug.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(item).toBeTruthy();
    expect(item.occupancyPct).toBe(0);
    expect(item.action).toBe('lower'); // 0% ocupación → −8%
    expect(item.suggestedPrice).toBe(92); // 100 × 0.92

    // Aplicar el precio sugerido.
    const applied = await request(app.getHttpServer())
      .post('/analytics/unit-pricing-suggestions/apply')
      .set(auth)
      .send({ unitId, price: item.suggestedPrice });
    expect(applied.status).toBe(201);
    expect(applied.body.previousPrice).toBe(100);
    expect(applied.body.newPrice).toBe(92);

    // El trastero refleja el nuevo precio.
    const updated = await request(app.getHttpServer()).get(`/units/${unitId}`).set(auth);
    expect(Number(updated.body.basePriceMonthly)).toBe(92);
  });
});
