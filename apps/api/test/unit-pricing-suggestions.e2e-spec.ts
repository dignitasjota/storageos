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
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
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
    // 0 % ocupado frente al 88 % objetivo → demanda −10 %; sin competencia la
    // confianza es baja y el paso es la mitad del máximo (8 % / 2).
    expect(item.action).toBe('lower');
    expect(item.targetPrice).toBe(90);
    expect(item.suggestedPrice).toBe(96);
    expect(item.marketPrice).toBeNull();
    expect(item.confidence).toBe('low');

    // Aplicar el precio sugerido.
    const applied = await request(app.getHttpServer())
      .post('/analytics/unit-pricing-suggestions/apply')
      .set(auth)
      .send({ unitId, price: item.suggestedPrice });
    expect(applied.status).toBe(201);
    expect(applied.body.previousPrice).toBe(100);
    expect(applied.body.newPrice).toBe(96);

    // El trastero refleja el nuevo precio.
    const updated = await request(app.getHttpServer()).get(`/units/${unitId}`).set(auth);
    expect(Number(updated.body.basePriceMonthly)).toBe(96);

    // Recién cambiado: no se vuelve a sugerir hasta pasados los días mínimos.
    const again = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item2 = again.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(item2.action).toBe('hold');
    expect(item2.holdReason).toContain('cambió');
  });

  it('estrategia: límites del tipo, cambio máximo y espera entre cambios', async () => {
    const owner = await registerVerifiedUser(app, 'pricestrat');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local ES', addressLine1: 'C/ T 1', city: 'Madrid', postalCode: '28001' });
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 100 });
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: unitType.body.id,
      code: 'ES-001',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 100,
    });

    const defaults = await request(app.getHttpServer())
      .get('/analytics/pricing-strategy')
      .set(auth);
    expect(defaults.status).toBe(200);
    expect(defaults.body).toMatchObject({
      targetOccupancy: 88,
      maxStepPct: 8,
      minDaysBetweenChanges: 30,
    });
    expect(defaults.body.facilities[0]).toMatchObject({ positioningPct: 0 });

    // Mínimo > máximo → 400.
    await request(app.getHttpServer())
      .put('/analytics/pricing-strategy')
      .set(auth)
      .send({ unitTypes: [{ id: unitType.body.id, minPrice: 120, maxPrice: 100 }] })
      .expect(400);

    const saved = await request(app.getHttpServer())
      .put('/analytics/pricing-strategy')
      .set(auth)
      .send({
        maxStepPct: 20,
        facilities: [{ id: facility.body.id, positioningPct: 5 }],
        unitTypes: [{ id: unitType.body.id, minPrice: 98, maxPrice: null }],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.maxStepPct).toBe(20);
    expect(saved.body.facilities[0].positioningPct).toBe(5);
    expect(saved.body.unitTypes[0]).toMatchObject({ minPrice: 98, maxPrice: null });

    // Sin ocupación pediría bajar (paso 10 % con confianza baja), pero el mínimo es 98.
    const sug = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item = sug.body.items.find((i: { unitId: string }) => i.unitId === unit.body.id);
    expect(item.suggestedPrice).toBe(98);

    // Sin permiso de gestión no se puede cambiar (sin sesión → 401).
    await request(app.getHttpServer()).put('/analytics/pricing-strategy').send({}).expect(401);
  });
});
