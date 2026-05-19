import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('/me PATCH + change-password (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('PATCH /me actualiza fullName y phone', async () => {
    const user = await registerVerifiedUser(app, 'me-patch');
    const res = await request(app.getHttpServer())
      .patch('/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ fullName: 'Jota Editado', phone: '+34 600 111 222' });
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe('Jota Editado');
    expect(res.body.phone).toBe('+34 600 111 222');
  });

  it('change-password con password incorrecta -> 403', async () => {
    const user = await registerVerifiedUser(app, 'me-cp-bad');
    const res = await request(app.getHttpServer())
      .post('/me/change-password')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('Cookie', user.refreshCookie)
      .send({ currentPassword: 'WrongPass1', newPassword: 'AnotherSecret9' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('wrong_current_password');
  });

  it('change-password OK revoca otras sesiones, mantiene la actual', async () => {
    const user = await registerVerifiedUser(app, 'me-cp-ok');
    // Crear 2 sesiones adicionales (login).
    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantSlug: user.slug, email: user.email, password: 'Secret123' });
      expect(res.status).toBe(200);
    }
    const before = await admin.session.count({ where: { userId: user.userId, revokedAt: null } });
    expect(before).toBe(3);

    const cp = await request(app.getHttpServer())
      .post('/me/change-password')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .set('Cookie', user.refreshCookie)
      .send({ currentPassword: 'Secret123', newPassword: 'BrandNew456' });
    expect(cp.status).toBe(204);

    const after = await admin.session.count({ where: { userId: user.userId, revokedAt: null } });
    expect(after).toBe(1); // queda solo la sesion actual

    // Login con la nueva password funciona.
    const newLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: 'BrandNew456' });
    expect(newLogin.status).toBe(200);
  });
});
