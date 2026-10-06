import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Tendencia del mercado y efecto de los cambios de precio (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local T', addressLine1: 'C/ T 1', city: 'Madrid', postalCode: '28001' });
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 100 });
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: unitType.body.id,
      code: 'T-001',
      widthM: 2,
      depthM: 2.5,
      heightM: 2.5,
      basePriceMonthly: 100,
    });
    return { auth, facilityId: facility.body.id as string, unitId: unit.body.id as string };
  }

  it('la tendencia aparece con 3 trasteros de la competencia revisados con 60+ días de diferencia', async () => {
    const { auth, facilityId, unitId } = await setup('trend');
    const comp = await request(app.getHttpServer())
      .post('/competitors')
      .set(auth)
      .send({ name: 'Rival T', facilityId });
    const admin = app.get(PrismaAdminService);
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    for (const [from, to] of [
      [100, 106],
      [50, 53],
      [80, 85],
    ] as const) {
      const u = await request(app.getHttpServer())
        .post(`/competitors/${comp.body.id}/units`)
        .set(auth)
        .send({ areaM2: 5, priceMonthly: to, status: 'available' });
      // Primera revisión hace 150 días con el precio anterior.
      await admin.competitorUnitObservation.updateMany({
        where: { competitorUnitId: u.body.id },
        data: { observedAt: ago(5) },
      });
      const { tenantId } = await admin.competitorUnit.findUniqueOrThrow({
        where: { id: u.body.id },
      });
      await admin.competitorUnitObservation.create({
        data: {
          tenantId,
          competitorUnitId: u.body.id,
          observedAt: ago(150),
          priceMonthly: from,
          status: 'available',
        },
      });
    }

    const sug = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item = sug.body.items.find((i: { unitId: string }) => i.unitId === unitId);
    expect(item.marketTrend).toMatchObject({ changePct: 6, units: 3, months: 5 });
  });

  it('efecto de un cambio de precio: cuánto tardó en alquilarse después', async () => {
    const { auth, unitId } = await setup('effects');

    const empty = await request(app.getHttpServer())
      .get('/analytics/price-change-effects')
      .set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);

    await request(app.getHttpServer())
      .post('/analytics/unit-pricing-suggestions/apply')
      .set(auth)
      .send({ unitId, price: 90 })
      .expect(201);

    const free = await request(app.getHttpServer())
      .get('/analytics/price-change-effects')
      .set(auth);
    expect(free.body.items[0]).toMatchObject({
      unitId,
      previousPrice: 100,
      newPrice: 90,
      changePct: -10,
      daysToRentAfter: null,
      stillFreeDays: 0,
    });
    expect(free.body.lowers).toMatchObject({ changes: 1, rented: 0 });

    await request(app.getHttpServer())
      .post(`/units/${unitId}/change-status`)
      .set(auth)
      .send({ status: 'reserved', reason: 'test' })
      .expect(200);
    const rented = await request(app.getHttpServer())
      .get('/analytics/price-change-effects')
      .set(auth);
    expect(rented.body.items[0]).toMatchObject({ daysToRentAfter: 0, stillFreeDays: null });
    expect(rented.body.lowers).toMatchObject({ changes: 1, rented: 1, avgDaysAfter: 0 });
  });
});
