import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: checklist de onboarding del tenant (e2e)', () => {
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

  it('refleja el progreso de configuración del tenant', async () => {
    const owner = await registerVerifiedUser(app, 'onboard');
    const admin = await seedSuperAdmin('onboard');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/onboarding`)
      .expect(401);

    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/onboarding`)
      .set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(Array.isArray(res.body.items)).toBe(true);
    // El owner ya está verificado (registerVerifiedUser) → ese paso está hecho.
    const emailItem = res.body.items.find((i: { key: string }) => i.key === 'email_verified');
    expect(emailItem.done).toBe(true);
    // Sin locales/contratos todavía → esos pasos pendientes.
    const facility = res.body.items.find((i: { key: string }) => i.key === 'facility');
    expect(facility.done).toBe(false);
    expect(res.body.completed).toBeGreaterThanOrEqual(1);
    expect(res.body.completed).toBeLessThan(7);
  });
});
