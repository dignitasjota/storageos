import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Las features premium del plan salen de la BD (`subscription_plans.tenant_features`),
 * editable desde /admin/plans, no del mapa en código. Verifica que editar el plan
 * cambia lo que `/auth/me` devuelve como `features`.
 */
describe('Features por plan data-driven (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('editar tenantFeatures del plan cambia las features efectivas del tenant', async () => {
    // Tenant nuevo → plan starter (no incluye ai_assistant por defecto).
    const owner = await registerVerifiedUser(app, 'plandd');
    const me1 = await request(app.getHttpServer())
      .get('/auth/me')
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(me1.status).toBe(200);
    expect(me1.body.features).not.toContain('ai_assistant');
    expect(me1.body.features).toContain('insurance'); // starter sí lo trae

    // Super admin edita el plan starter y le AÑADE ai_assistant.
    const admin = await seedSuperAdmin('plandd');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    const plans = await request(app.getHttpServer()).get('/subscription-plans/admin').set(auth);
    const starter = plans.body.find((p: { slug: string }) => p.slug === 'starter');
    expect(starter).toBeTruthy();
    expect(Array.isArray(starter.tenantFeatures)).toBe(true);

    const patched = await request(app.getHttpServer())
      .patch(`/subscription-plans/${starter.id}`)
      .set(auth)
      .send({ tenantFeatures: [...starter.tenantFeatures, 'ai_assistant'] });
    expect(patched.status).toBe(200);
    expect(patched.body.tenantFeatures).toContain('ai_assistant');

    // El tenant, al volver a pedir /me, ya ve ai_assistant (sin tocar su plan).
    const me2 = await request(app.getHttpServer())
      .get('/auth/me')
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(me2.body.features).toContain('ai_assistant');

    // Restaurar el plan starter para no contaminar otras suites.
    await request(app.getHttpServer())
      .patch(`/subscription-plans/${starter.id}`)
      .set(auth)
      .send({ tenantFeatures: starter.tenantFeatures });
  });
});
