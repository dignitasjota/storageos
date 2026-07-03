import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-fin-test@storageos.local';

describe('Dashboard financiero SaaS (e2e)', () => {
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
        fullName: 'Admin Fin',
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

  it('desglosa los ingresos cobrados por fuente y por mes', async () => {
    const owner = await registerVerifiedUser(app, 'fin-tenant');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const billing = app.get(BillingSaasService, { strict: false });
    await billing.recordManualPayment({
      tenantId: tenant!.id,
      provider: 'bank_transfer',
      amount: 49,
      currency: 'EUR',
      durationMonths: 1,
      extendsPeriod: true,
    });

    const res = await request(app.getHttpServer())
      .get('/admin/finance?months=12')
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
    expect(res.body.manualTotal).toBeGreaterThanOrEqual(49);
    expect(res.body.monthly).toHaveLength(12);
    const manualSlice = res.body.byProvider.find(
      (p: { provider: string }) => p.provider === 'bank_transfer',
    );
    expect(manualSlice).toBeTruthy();
    expect(manualSlice.total).toBeGreaterThanOrEqual(49);
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/finance').expect(401);
  });
});
