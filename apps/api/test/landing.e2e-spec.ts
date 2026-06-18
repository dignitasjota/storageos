import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Landing pública por tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve tenant + facilities con disponibilidad y precio (sin auth)', async () => {
    const owner = await registerVerifiedUser(app, 'landing-ok');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Centro',
      unitsCount: 3,
      pricePerUnit: 65,
    });

    const res = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantSlug).toBe(owner.slug);
    expect(Array.isArray(res.body.facilities)).toBe(true);
    const fac = res.body.facilities.find((f: { name: string }) => f.name === 'Local Centro');
    expect(fac).toBeTruthy();
    expect(fac.unitTypes.length).toBeGreaterThanOrEqual(1);
    expect(fac.unitTypes[0].available).toBeGreaterThan(0);
    expect(fac.unitTypes[0].priceMonthly).toBe(65);
  });

  it('slug desconocido devuelve 404', async () => {
    const res = await request(app.getHttpServer()).get('/public/landing/no-existe-xyz');
    expect(res.status).toBe(404);
  });
});
