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

const ADMIN_EMAIL = 'admin-metrics-test@storageos.local';

describe('Admin metrics (e2e)', () => {
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
        fullName: 'Admin Metrics Test',
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

  it('devuelve el overview ampliado con series y distribuciones', async () => {
    // Un tenant nuevo entra en el conteo (al menos 1 en trial + en starter).
    await registerVerifiedUser(app, 'admin-metrics');

    const res = await request(app.getHttpServer())
      .get('/admin/metrics')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const m = res.body;

    // Tenants
    expect(m.tenants.total).toBeGreaterThanOrEqual(1);
    expect(m.tenants).toHaveProperty('trial');

    // Negocio + alertas
    expect(m.mrr).toHaveProperty('total');
    expect(m.mrr.currency).toBe('EUR');
    expect(m).toHaveProperty('trialsExpiringSoon');
    expect(m).toHaveProperty('openSupportTickets');
    expect(typeof m.averageRevenuePerTenant).toBe('number');

    // Plataforma
    expect(m.platform).toEqual(
      expect.objectContaining({
        facilities: expect.any(Number),
        units: expect.any(Number),
        customers: expect.any(Number),
        contracts: expect.any(Number),
        users: expect.any(Number),
      }),
    );

    // Distribución por plan: el tenant nuevo es 'starter'
    expect(Array.isArray(m.tenantsByPlan)).toBe(true);
    expect(m.tenantsByPlan.some((p: { planSlug: string }) => p.planSlug === 'starter')).toBe(true);

    // Series mensuales: 12 puntos cada una
    expect(m.monthlyGrowth).toHaveLength(12);
    expect(m.monthlySaasRevenue).toHaveLength(12);
    expect(m.monthlyGrowth[11]).toHaveProperty('signups');
    expect(m.monthlyGrowth[11].signups).toBeGreaterThanOrEqual(1); // alta de este mes

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get('/admin/metrics');
    expect(noAuth.status).toBe(401);
  });
});
