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
const ADMIN_EMAIL = 'admin-aa-test@storageos.local';

describe('Analítica global de add-ons (e2e)', () => {
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
        fullName: 'Admin AA',
        role: 'superadmin',
      },
    });
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-aa' } });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-aa' } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('cuenta tenants activos y MRR por add-on', async () => {
    const owner = await registerVerifiedUser(app, 'aa-tenant');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const bearer = { Authorization: `Bearer ${adminToken}` };
    const created = await request(app.getHttpServer())
      .post('/admin/addons')
      .set(bearer)
      .send({ slug: 'e2e-aa', name: 'Analytics AA', priceMonthly: 20 });
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant!.id}/addons`)
      .set(bearer)
      .send({ addonId: created.body.id, quantity: 1 })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/admin/addons/analytics').set(bearer);
    expect(res.status).toBe(200);
    const mine = res.body.find((r: { slug: string }) => r.slug === 'e2e-aa');
    expect(mine).toBeTruthy();
    expect(mine.tenantsActive).toBe(1);
    expect(mine.monthlyRevenue).toBe(20);
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/addons/analytics').expect(401);
  });
});
