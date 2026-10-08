import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Actualización de renta por aniversario (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('propone, aplica o descarta según el alcance y el % del tenant', async () => {
    const owner = await registerVerifiedUser(app, 'anniv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'housing', true);
    const housing = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 700,
    });
    const storage = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });
    await request(app.getHttpServer())
      .patch(`/unit-types/${housing.unitTypeId}`)
      .set(auth)
      .send({ propertyKind: 'housing' })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken);
    // Empezaron hace un año y 10 días: el aniversario fue hace 10 días.
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate() - 10),
    )
      .toISOString()
      .slice(0, 10);
    const sign = async (unitId: string, price: number) => {
      const c = await request(app.getHttpServer())
        .post('/contracts')
        .set(auth)
        .send({ customerId, unitId, startDate: start, priceMonthly: price, depositAmount: 0 });
      await request(app.getHttpServer())
        .post(`/contracts/${c.body.id}/sign`)
        .set(auth)
        .send({})
        .expect(200);
      return c.body.id as string;
    };
    const flat = await sign(housing.unitIds[0]!, 700);
    const box = await sign(storage.unitIds[0]!, 50);

    // Desactivada: nada que proponer.
    expect(
      (await request(app.getHttpServer()).get('/contract-anniversaries/due').set(auth)).body,
    ).toEqual([]);

    await request(app.getHttpServer())
      .put('/contract-anniversaries/settings')
      .set(auth)
      .send({ enabled: true, pct: 3, scope: 'housing' })
      .expect(200);
    const onlyHousing = await request(app.getHttpServer())
      .get('/contract-anniversaries/due')
      .set(auth);
    expect(onlyHousing.body).toHaveLength(1);
    expect(onlyHousing.body[0]).toMatchObject({
      contractId: flat,
      propertyKind: 'housing',
      currentPrice: 700,
      newPrice: 721,
    });

    await request(app.getHttpServer())
      .put('/contract-anniversaries/settings')
      .set(auth)
      .send({ enabled: true, pct: 3, scope: 'all' })
      .expect(200);
    const all = await request(app.getHttpServer()).get('/contract-anniversaries/due').set(auth);
    expect(all.body).toHaveLength(2);

    const applied = await request(app.getHttpServer())
      .post('/contract-anniversaries/apply')
      .set(auth)
      .send({ contractIds: [flat] });
    expect(applied.body).toEqual({ applied: 1, skipped: 0, failed: [] });
    const flatDetail = await request(app.getHttpServer()).get(`/contracts/${flat}`).set(auth);
    expect(flatDetail.body.priceMonthly).toBe(721);

    const skipped = await request(app.getHttpServer())
      .post('/contract-anniversaries/apply')
      .set(auth)
      .send({ contractIds: [box], action: 'skip' });
    expect(skipped.body).toEqual({ applied: 0, skipped: 1, failed: [] });
    const boxDetail = await request(app.getHttpServer()).get(`/contracts/${box}`).set(auth);
    expect(boxDetail.body.priceMonthly).toBe(50);

    // Ya resueltos este año.
    expect(
      (await request(app.getHttpServer()).get('/contract-anniversaries/due').set(auth)).body,
    ).toEqual([]);
    const again = await request(app.getHttpServer())
      .post('/contract-anniversaries/apply')
      .set(auth)
      .send({ contractIds: [flat] });
    expect(again.body.failed).toHaveLength(1);
  });
});
