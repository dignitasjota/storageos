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

const ADMIN_EMAIL = 'admin-atrisk-test@storageos.local';

describe('Admin tenants at-risk (e2e)', () => {
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
        fullName: 'Admin AtRisk Test',
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

  it('detecta un trial recién creado como "trial por expirar"', async () => {
    // El registro crea un tenant en trial; ajustamos su fin de trial a +3 días
    // para que entre en la ventana de 7.
    const owner = await registerVerifiedUser(app, 'admin-risk');
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await adminClient.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'trial', trialEndsAt: soon },
    });

    const res = await request(app.getHttpServer())
      .get('/admin/tenants/at-risk')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.trialExpiring)).toBe(true);
    expect(Array.isArray(res.body.pastDue)).toBe(true);
    expect(Array.isArray(res.body.inactive)).toBe(true);
    const mine = res.body.trialExpiring.find((t: { id: string }) => t.id === owner.tenantId);
    expect(mine).toBeTruthy();
    expect(mine.reason).toBe('trial_expiring');
    expect(mine.since).toBeTruthy();

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get('/admin/tenants/at-risk');
    expect(noAuth.status).toBe(401);
  });
});
