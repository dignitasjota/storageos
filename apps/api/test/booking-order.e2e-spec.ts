import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Reserva online: tamaños del más barato al más caro (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('ordena los tamaños por precio, no por nombre', async () => {
    const owner = await registerVerifiedUser(app, 'bookorder');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // Por nombre saldrían Amplio, Básico, Cómodo; por precio, Básico va al final.
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      typeName: 'Básico',
      pricePerUnit: 90,
      unitsCount: 1,
    });
    for (const [name, price] of [
      ['Amplio', 40],
      ['Cómodo', 60],
    ] as const) {
      const type = await request(app.getHttpServer())
        .post('/unit-types')
        .set(auth)
        .send({ name, defaultPriceMonthly: price, color: '#3366ff' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/units')
        .set(auth)
        .send({
          facilityId,
          unitTypeId: type.body.id,
          code: `T${price}`,
          widthM: 2,
          depthM: 2,
          heightM: 2.5,
          basePriceMonthly: price,
        })
        .expect(201);
    }

    const avail = await request(app.getHttpServer())
      .get(`/public/move-in/book/${owner.slug}/availability`)
      .expect(200);
    const names = avail.body.facilities[0].unitTypes.map((t: { name: string }) => t.name);
    expect(names).toEqual(['Amplio', 'Cómodo', 'Básico']);
  });
});
