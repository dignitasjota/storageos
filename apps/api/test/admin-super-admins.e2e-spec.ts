import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: gestión de super admins (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  it('lista, crea y activa/desactiva super admins con guards', async () => {
    const admin = await seedSuperAdmin('sa-mgmt');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    // Sin token → 401.
    await request(app.getHttpServer()).get('/admin/super-admins').expect(401);

    // Lista (al menos el seed).
    const list = await request(app.getHttpServer()).get('/admin/super-admins').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.some((a: { email: string }) => a.email === admin.email)).toBe(true);

    // Crear uno nuevo (rol support).
    const newEmail = `storageos-test-sa-new-${Date.now()}@storageos.local`;
    const created = await request(app.getHttpServer()).post('/admin/super-admins').set(auth).send({
      email: newEmail,
      fullName: 'Nuevo Soporte',
      password: 'NuevoSoporte!23',
      role: 'support',
    });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe('support');
    expect(created.body.isActive).toBe(true);

    // Desactivar al nuevo → ok.
    const off = await request(app.getHttpServer())
      .patch(`/admin/super-admins/${created.body.id}/active`)
      .set(auth)
      .send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);

    // No puede modificarse a sí mismo.
    const self = await request(app.getHttpServer())
      .patch(`/admin/super-admins/${admin.id}/active`)
      .set(auth)
      .send({ isActive: false });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('cannot_modify_self');

    // Email duplicado → rechazado.
    const dup = await request(app.getHttpServer())
      .post('/admin/super-admins')
      .set(auth)
      .send({ email: newEmail, fullName: 'Dup', password: 'NuevoSoporte!23', role: 'support' });
    expect(dup.status).toBeGreaterThanOrEqual(400);
  });
});
