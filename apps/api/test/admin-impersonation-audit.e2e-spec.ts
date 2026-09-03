import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: auditoría de impersonación (e2e)', () => {
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

  it(
    'revocar una sesión de impersonación EN CURSO invalida el JWT ya emitido en la ' +
      'siguiente request (antes `revokedAt` nunca se escribía — badge muerto)',
    async () => {
      const admin = await seedSuperAdmin('imp-revoke');
      const login = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };

      const owner = await registerVerifiedUser(app, 'imp-revoke-tenant');
      const imp = await request(app.getHttpServer())
        .post(`/admin/tenants/${owner.tenantId}/impersonate`)
        .set(auth)
        .send({ reason: 'verificar datos' });
      expect(imp.status).toBe(200);
      const impersonationToken = imp.body.accessToken as string;
      const impAuth = { Authorization: `Bearer ${impersonationToken}` };

      // El token de impersonación funciona con normalidad ANTES de revocar.
      const before = await request(app.getHttpServer()).get('/auth/me').set(impAuth);
      expect(before.status).toBe(200);

      // Encuentra la sesión recién creada (la más reciente de este tenant).
      const sessions = await request(app.getHttpServer())
        .get(`/admin/impersonation-logs?tenantId=${owner.tenantId}`)
        .set(auth);
      expect(sessions.status).toBe(200);
      const session = sessions.body[0] as { id: string; revokedAt: string | null };
      expect(session.revokedAt).toBeNull();

      // Revoca.
      const revoked = await request(app.getHttpServer())
        .post(`/admin/impersonation-logs/${session.id}/revoke`)
        .set(auth);
      expect(revoked.status).toBe(200);
      expect(revoked.body.revokedAt).toBeTruthy();

      // El MISMO token, ya emitido, ahora es rechazado — no solo el registro.
      const after = await request(app.getHttpServer()).get('/auth/me').set(impAuth);
      expect(after.status).toBe(401);
      expect(after.body.code).toBe('impersonation_revoked');

      // Revocar dos veces → 400 (idempotencia explícita, no un segundo timestamp).
      const dup = await request(app.getHttpServer())
        .post(`/admin/impersonation-logs/${session.id}/revoke`)
        .set(auth);
      expect(dup.status).toBe(400);
      expect(dup.body.code).toBe('already_revoked');

      // Sesión inexistente → 404.
      await request(app.getHttpServer())
        .post('/admin/impersonation-logs/00000000-0000-0000-0000-000000000000/revoke')
        .set(auth)
        .expect(404);
    },
  );
});
