import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-notes-test@storageos.local';

describe('Notas y LTV del tenant (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Notes',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('guarda y lee las notas/LTV/tags del tenant', async () => {
    const owner = await registerVerifiedUser(app, 'notes-t');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const bearer = { Authorization: `Bearer ${adminToken}` };

    const initial = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenant!.id}/notes`)
      .set(bearer);
    expect(initial.status).toBe(200);
    expect(initial.body.ltvTier).toBeNull();
    expect(initial.body.tags).toEqual([]);

    const put = await request(app.getHttpServer())
      .put(`/admin/tenants/${tenant!.id}/notes`)
      .set(bearer)
      .send({
        ltvTier: 'high',
        strategicNotes: 'Cuenta clave, revisar upsell',
        tags: ['cuenta_clave', 'expansion'],
      });
    expect(put.status).toBe(200);
    expect(put.body.ltvTier).toBe('high');
    expect(put.body.tags).toEqual(['cuenta_clave', 'expansion']);

    const after = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenant!.id}/notes`)
      .set(bearer);
    expect(after.body.strategicNotes).toBe('Cuenta clave, revisar upsell');
  });

  it('sin token → 401', async () => {
    const owner = await registerVerifiedUser(app, 'notes-401');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    await request(app.getHttpServer()).get(`/admin/tenants/${tenant!.id}/notes`).expect(401);
  });
});
