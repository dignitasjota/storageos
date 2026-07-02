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

  it('ocupación de mercado: la mía (0%) vs la de la competencia (inferida)', async () => {
    const owner = await registerVerifiedUser(app, 'market-occ');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Mi local con 1 trastero disponible → mi ocupación 0%.
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local', addressLine1: 'C/ X', city: 'Madrid', postalCode: '28001' });
    const ut = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Std', defaultPriceMonthly: 100 });
    await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: ut.body.id,
      code: 'A-1',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 100,
    });

    // Sin competencia fichada → competitionOccupancyPct null, totales 0.
    const empty = await request(app.getHttpServer()).get('/competitors/occupancy').set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.myTotalUnits).toBe(1);
    expect(empty.body.myOccupancyPct).toBe(0);
    expect(empty.body.competitionOccupancyPct).toBeNull();
    expect(empty.body.competitionTotalUnits).toBe(0);

    // Competidor con 4 trasteros: 3 ocupados, 1 disponible → 75%.
    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Rival', zone: 'Z' });
    for (const st of ['occupied', 'occupied', 'occupied', 'available']) {
      await request(app.getHttpServer())
        .post(`/competitors/${comp.body.id}/units`)
        .set(auth)
        .send({ areaM2: 5, priceMonthly: 90, status: st })
        .expect(201);
    }

    const occ = await request(app.getHttpServer()).get('/competitors/occupancy').set(auth);
    expect(occ.body.competitionTotalUnits).toBe(4);
    expect(occ.body.competitionOccupiedUnits).toBe(3);
    expect(occ.body.competitionOccupancyPct).toBe(0.75);
    expect(occ.body.competitors).toHaveLength(1);
    expect(occ.body.competitors[0]).toMatchObject({
      name: 'Rival',
      unitCount: 4,
      occupiedCount: 3,
      occupancyPct: 0.75,
    });
  });
});
