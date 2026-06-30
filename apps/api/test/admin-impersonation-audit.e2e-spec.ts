import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: auditoría de impersonación (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  it('lista las sesiones de impersonación', async () => {
    const admin = await seedSuperAdmin('imp-audit');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    await request(app.getHttpServer()).get('/admin/impersonation-logs').expect(401);

    const res = await request(app.getHttpServer()).get('/admin/impersonation-logs').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // Actividad de una sesión inexistente → 404.
    await request(app.getHttpServer())
      .get('/admin/impersonation-logs/00000000-0000-0000-0000-000000000000/activity')
      .set(auth)
      .expect(404);
  });
});
