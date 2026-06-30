import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: overrides de feature por tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
  });

  async function loginAsSuperAdmin(): Promise<string> {
    const admin = await seedSuperAdmin('feat-ov');
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect([200, 201]).toContain(res.status);
    return res.body.accessToken as string;
  }

  it('activa una feature fuera del plan y se refleja en /auth/me y el FeatureGuard', async () => {
    // Tenant nuevo: plan `starter` (no incluye ai_assistant).
    const owner = await registerVerifiedUser(app, 'featov');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const token = await loginAsSuperAdmin();
    const adminAuth = { Authorization: `Bearer ${token}` };

    // Estado inicial: ai_assistant NO está.
    const before = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/features`)
      .set(adminAuth);
    expect(before.status).toBe(200);
    expect(before.body.effective).not.toContain('ai_assistant');
    expect(before.body.overrides).toHaveLength(0);

    const me0 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me0.body.features).not.toContain('ai_assistant');
    // El asistente IA requiere la feature → 503/403 sin ella (no 200).
    const ai0 = await request(app.getHttpServer()).get('/ai/conversations').set(tenantAuth);
    expect(ai0.status).toBe(403);

    // El super admin activa ai_assistant por override.
    const put = await request(app.getHttpServer())
      .put(`/admin/tenants/${owner.tenantId}/features`)
      .set(adminAuth)
      .send({ overrides: [{ feature: 'ai_assistant', enabled: true }] });
    expect(put.status).toBe(200);
    expect(put.body.effective).toContain('ai_assistant');
    expect(put.body.overrides).toEqual([{ feature: 'ai_assistant', enabled: true }]);

    // Ahora /auth/me la incluye y el FeatureGuard deja pasar.
    const me1 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me1.body.features).toContain('ai_assistant');
    const ai1 = await request(app.getHttpServer()).get('/ai/conversations').set(tenantAuth);
    expect(ai1.status).toBe(200);

    // Quitarla (overrides vacío) → vuelve a 403.
    await request(app.getHttpServer())
      .put(`/admin/tenants/${owner.tenantId}/features`)
      .set(adminAuth)
      .send({ overrides: [] })
      .expect(200);
    const ai2 = await request(app.getHttpServer()).get('/ai/conversations').set(tenantAuth);
    expect(ai2.status).toBe(403);

    // Sin token de admin → 401.
    await request(app.getHttpServer()).get(`/admin/tenants/${owner.tenantId}/features`).expect(401);
  });
});
