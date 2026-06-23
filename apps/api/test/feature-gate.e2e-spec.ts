import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Gating por plan en backend (@RequireFeature) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('bloquea una feature fuera del plan y la deja pasar tras subir de plan', async () => {
    // El registro crea el tenant en `starter`, que NO incluye `ai_assistant`.
    const owner = await registerVerifiedUser(app, 'featgate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const blocked = await request(app.getHttpServer()).get('/ai/conversations').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('feature_not_in_plan');
    expect(blocked.body.details).toMatchObject({ requiredFeature: 'ai_assistant' });

    // `starter` SÍ incluye `automations` → pasa el gate (200).
    const allowedStarter = await request(app.getHttpServer()).get('/automations').set(auth);
    expect(allowedStarter.status).toBe(200);

    // Subimos a `pro` (incluye todas) → la IA ya entra.
    await setTenantPlan(owner.slug, 'pro');
    const allowed = await request(app.getHttpServer()).get('/ai/conversations').set(auth);
    expect(allowed.status).toBe(200);
  });
});
