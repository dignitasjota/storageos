import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Marketing — borrador de campaña de Ads con IA (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('requiere autenticación', async () => {
    await request(app.getHttpServer())
      .post('/marketing/ad-campaign-draft')
      .send({ platform: 'google_ads' })
      .expect(401);
  });

  it('bloqueado en starter (sin `ai_assistant`), disponible al subir a pro', async () => {
    const owner = await registerVerifiedUser(app, 'ad-draft');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const blocked = await request(app.getHttpServer())
      .post('/marketing/ad-campaign-draft')
      .set(auth)
      .send({ platform: 'google_ads' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('feature_not_in_plan');

    await setTenantPlan(owner.slug, 'pro');

    const res = await request(app.getHttpServer())
      .post('/marketing/ad-campaign-draft')
      .set(auth)
      .send({ platform: 'google_ads' });
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('google_ads');
    expect(typeof res.body.draft).toBe('string');
    expect(res.body.draft.length).toBeGreaterThan(0);
  });

  it('redacta con local concreto (meta_ads) y 404 si el local no existe', async () => {
    const owner = await registerVerifiedUser(app, 'ad-draft-facility');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Ads',
      unitsCount: 2,
      pricePerUnit: 40,
    });

    const res = await request(app.getHttpServer())
      .post('/marketing/ad-campaign-draft')
      .set(auth)
      .send({ platform: 'meta_ads', facilityId });
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('meta_ads');
    expect(res.body.draft.length).toBeGreaterThan(0);

    const ghost = await request(app.getHttpServer())
      .post('/marketing/ad-campaign-draft')
      .set(auth)
      .send({ platform: 'meta_ads', facilityId: '01000000-0000-7000-8000-000000000000' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('facility_not_found');
  });
});
