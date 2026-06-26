import { hash as argonHash } from '@node-rs/argon2';
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

const ADMIN_EMAIL = 'admin-support-test@storageos.local';

describe('Admin support actions (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Support Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('edita el tenant y aplica acciones de soporte sobre el usuario', async () => {
    const owner = await registerVerifiedUser(app, 'admin-supp');
    const auth = { Authorization: `Bearer ${token}` };

    // Editar datos del tenant
    const upd = await request(app.getHttpServer())
      .patch(`/admin/tenants/${owner.tenantId}`)
      .set(auth)
      .send({
        name: 'Renombrado SL',
        billingEmail: 'nuevo@empresa.com',
        timezone: 'Europe/Madrid',
      });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('Renombrado SL');
    expect(upd.body.billingEmail).toBe('nuevo@empresa.com');

    // Localizar al owner (único usuario del tenant)
    const users = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/users`)
      .set(auth);
    const ownerUser = users.body.find((u: { email: string }) => u.email === owner.email);
    expect(ownerUser).toBeTruthy();
    const userId = ownerUser.id as string;

    // Reenviar verificación a un usuario YA verificado -> 400
    const resend = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/users/${userId}/resend-verification`)
      .set(auth);
    expect(resend.status).toBe(400);

    // Reset de contraseña -> 200
    const reset = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/users/${userId}/password-reset`)
      .set(auth);
    expect(reset.status).toBe(200);

    // Cerrar sesiones -> 200 { revoked: n }
    const revoke = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/users/${userId}/revoke-sessions`)
      .set(auth);
    expect(revoke.status).toBe(200);
    expect(typeof revoke.body.revoked).toBe('number');

    // Quitar 2FA cuando no está activado -> 400
    const off2fa = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/users/${userId}/disable-2fa`)
      .set(auth);
    expect(off2fa.status).toBe(400);

    // Desactivar al único owner -> 400 last_owner
    const deact = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/users/${userId}/deactivate`)
      .set(auth);
    expect(deact.status).toBe(400);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/users/${userId}/revoke-sessions`)
      .send();
    expect(noAuth.status).toBe(401);
  });
});
