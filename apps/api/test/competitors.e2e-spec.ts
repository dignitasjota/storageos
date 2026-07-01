import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Competencia + precio por competencia (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('ficha competencia y ancla la sugerencia de precio', async () => {
    const owner = await registerVerifiedUser(app, 'competitor');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Mi local + tipo + trastero disponible caro (200€, 5 m²).
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Mi Local', addressLine1: 'C/ T 1', city: 'Madrid', postalCode: '28001' });
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 200 });
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: unitType.body.id,
      code: 'C-001',
      widthM: 2,
      depthM: 2.5,
      heightM: 2.5,
      basePriceMonthly: 200,
    });
    const unitId = unit.body.id as string;

    // Fichar un competidor con un trastero de ~5 m² a 100€ (yo estoy caro).
    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Rival Storage', zone: 'Centro' });
    expect(comp.status).toBe(201);
    const compUnit = await request(app.getHttpServer())
      .post(`/competitors/${comp.body.id}/units`)
      .set(auth)
      .send({ areaM2: 5, priceMonthly: 100, status: 'available' });
    expect(compUnit.status).toBe(201);
    expect(compUnit.body.lastCheckedAt).toBeTruthy();

    // Sin competencia: 0% ocupación → −8%.
    const noComp = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const base = noComp.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(base.changePct).toBe(-8);

    // Con competencia: además, mi 200€ >> mediana 100 → factor competencia −6% → −14%.
    const withComp = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions?includeCompetition=true')
      .set(auth);
    const item = withComp.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(item.changePct).toBe(-14);
    expect(item.factors.some((f: { label: string }) => f.label === 'Competencia')).toBe(true);

    // Marcar el trastero de la competencia como ocupado → deja de contar.
    await request(app.getHttpServer())
      .patch(`/competitors/units/${compUnit.body.id}`)
      .set(auth)
      .send({ status: 'occupied' })
      .expect(200);
    const afterOccupied = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions?includeCompetition=true')
      .set(auth);
    const item2 = afterOccupied.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(item2.changePct).toBe(-8); // sin referencias disponibles → vuelve al base
  });
});
