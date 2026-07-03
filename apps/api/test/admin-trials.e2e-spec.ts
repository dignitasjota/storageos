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
const ADMIN_EMAIL = 'admin-trials-test@storageos.local';

describe('Gestión de trials (e2e)', () => {
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
        fullName: 'Admin Trials',
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

  it('lista los trials con daysLeft y neverUsed', async () => {
    const owner = await registerVerifiedUser(app, 'trials-t');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const res = await request(app.getHttpServer())
      .get('/admin/tenants/trials')
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
    const mine = res.body.find((t: { id: string }) => t.id === tenant!.id);
    expect(mine).toBeTruthy();
    expect(typeof mine.daysLeft).toBe('number');
    expect(mine.neverUsed).toBe(true);
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/tenants/trials').expect(401);
  });
});
