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

  it('solo lectura: el panel recibe permisos de lectura y el API rechaza cualquier cambio', async () => {
    const admin = await seedSuperAdmin('imp-ro');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const owner = await registerVerifiedUser(app, 'imp-ro-tenant');

    const imp = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/impersonate`)
      .set(auth)
      .send({ reason: 'revisar facturas', readOnly: true })
      .expect(200);
    expect(imp.body.readOnly).toBe(true);
    const impAuth = { Authorization: `Bearer ${imp.body.accessToken as string}` };

    const me = await request(app.getHttpServer()).get('/auth/me').set(impAuth).expect(200);
    expect(me.body.impersonation.readOnly).toBe(true);
    expect(typeof me.body.impersonation.expiresAt).toBe('string');
    expect(me.body.permissions).toContain('customers:read');
    expect(me.body.permissions).not.toContain('customers:write');

    await request(app.getHttpServer()).get('/customers').set(impAuth).expect(200);
    const write = await request(app.getHttpServer())
      .post('/customers')
      .set(impAuth)
      .send({ customerType: 'individual', firstName: 'No', lastName: 'Debe' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('impersonation_read_only');

    const sessions = await request(app.getHttpServer())
      .get(`/admin/impersonation-logs?tenantId=${owner.tenantId}`)
      .set(auth)
      .expect(200);
    expect(sessions.body[0].readOnly).toBe(true);

    // La sesión del propietario de verdad no lleva `impersonation`.
    const ownerMe = await request(app.getHttpServer())
      .get('/auth/me')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    expect(ownerMe.body.impersonation).toBeUndefined();
  });

  it('con permiso de cambios, sigue sin poder tocar la contraseña, el perfil ni el 2FA', async () => {
    const admin = await seedSuperAdmin('imp-rw');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const owner = await registerVerifiedUser(app, 'imp-rw-tenant');

    const imp = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/impersonate`)
      .set(auth)
      .send({ reason: 'corregir un contrato', readOnly: false })
      .expect(200);
    const impAuth = { Authorization: `Bearer ${imp.body.accessToken as string}` };

    const me = await request(app.getHttpServer()).get('/auth/me').set(impAuth).expect(200);
    expect(me.body.impersonation.readOnly).toBe(false);

    for (const [method, path, body] of [
      ['post', '/me/change-password', { currentPassword: 'x', newPassword: 'NuevaClave!123' }],
      ['patch', '/me', { fullName: 'Otro nombre' }],
      ['post', '/auth/2fa/setup', {}],
      ['post', '/auth/logout-all', {}],
    ] as const) {
      const res = await request(app.getHttpServer())[method](path).set(impAuth).send(body);
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 403,
        code: 'not_allowed_while_impersonating',
      });
    }
    // El resto del panel sí admite cambios.
    await request(app.getHttpServer())
      .post('/customers')
      .set(impAuth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Prueba' })
      .expect(201);
  });
});
