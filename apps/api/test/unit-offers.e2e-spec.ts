import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Ofertas de un trastero concreto (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('se crea a mano, solo vale para su trastero y se gasta al contratarlo', async () => {
    const owner = await registerVerifiedUser(app, 'unitoffer');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: 'unit-offer@e2e.local',
    });
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const [target, other] = unitIds as [string, string];

    const created = await request(app.getHttpServer())
      .post('/promotions/unit-offers')
      .set(auth)
      .send({ unitId: target, freeMonths: 1, validDays: 30 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ unitId: target, freeMonths: 1 });
    expect(created.body.code).toMatch(/^OF-/);
    const code = created.body.code as string;

    // Una sola oferta activa por trastero.
    const dup = await request(app.getHttpServer())
      .post('/promotions/unit-offers')
      .set(auth)
      .send({ unitId: target, freeMonths: 2 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('unit_offer_exists');

    const list = await request(app.getHttpServer())
      .get(`/promotions/unit-offers?unitId=${target}`)
      .set(auth);
    expect(list.body).toHaveLength(1);

    // La sugerencia de precio del trastero muestra la oferta.
    const sug = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item = sug.body.items.find((i: { unitId: string }) => i.unitId === target);
    expect(item.activeOffer).toMatchObject({ code, freeMonths: 1 });
    expect(item.promotionHint).toBeNull();

    // Otro trastero: no aplica.
    const wrong = await request(app.getHttpServer())
      .post('/promotions/validate')
      .set(auth)
      .send({ code, monthlyPrice: 50, unitId: other });
    expect(wrong.body).toMatchObject({ valid: false, reason: 'not_for_unit' });
    const wrongContract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: other,
      startDate: '2026-07-01',
      priceMonthly: 50,
      depositAmount: 0,
      promotionCode: code,
    });
    expect(wrongContract.status).toBe(409);
    expect(wrongContract.body.code).toBe('promotion_not_for_unit');

    // Su trastero: 1 mes gratis y la oferta queda gastada.
    const ok = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: target,
      startDate: '2026-07-01',
      priceMonthly: 50,
      depositAmount: 0,
      promotionCode: code,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.freeMonthsRemaining).toBe(1);
    const after = await request(app.getHttpServer())
      .get(`/promotions/unit-offers?unitId=${target}`)
      .set(auth);
    expect(after.body).toHaveLength(0);
  });

  it('se puede retirar; no se crea para trasteros no disponibles', async () => {
    const owner = await registerVerifiedUser(app, 'unitoffer2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const unitId = unitIds[0]!;

    await request(app.getHttpServer())
      .post('/promotions/unit-offers')
      .set(auth)
      .send({ unitId, freeMonths: 1 })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/promotions/unit-offers/${unitId}`)
      .set(auth)
      .expect(204);
    await request(app.getHttpServer())
      .delete(`/promotions/unit-offers/${unitId}`)
      .set(auth)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/units/${unitId}/change-status`)
      .set(auth)
      .send({ status: 'maintenance', reason: 'test' })
      .expect(200);
    const blocked = await request(app.getHttpServer())
      .post('/promotions/unit-offers')
      .set(auth)
      .send({ unitId, freeMonths: 1 });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('unit_not_available');

    await request(app.getHttpServer())
      .post('/promotions/unit-offers')
      .send({ unitId, freeMonths: 1 })
      .expect(401);
  });
});
