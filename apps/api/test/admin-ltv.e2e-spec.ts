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

const ADMIN_EMAIL = 'admin-ltv-test@storageos.local';

describe('Admin LTV + cohortes de ingresos (e2e)', () => {
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
        fullName: 'Admin LTV Test',
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

  it('calcula LTV y cohortes con un tenant que ya pagó', async () => {
    // Registro crea un tenant; le sembramos 2 pagos `paid` de suscripción.
    const owner = await registerVerifiedUser(app, 'admin-ltv');
    await adminClient.tenantSubscriptionPayment.createMany({
      data: [
        {
          tenantId: owner.tenantId,
          provider: 'stripe',
          status: 'paid',
          amount: '29.00',
          currency: 'EUR',
          planSlug: 'starter',
          paidAt: new Date(),
        },
        {
          tenantId: owner.tenantId,
          provider: 'manual',
          status: 'paid',
          amount: '29.00',
          currency: 'EUR',
          planSlug: 'starter',
          paidAt: new Date(),
        },
      ],
    });

    const res = await request(app.getHttpServer())
      .get('/admin/metrics/ltv')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const m = res.body;

    // Estructura
    expect(m.currency).toBe('EUR');
    expect(typeof m.avgLtv).toBe('number');
    expect(typeof m.realizedLtv).toBe('number');
    expect(typeof m.avgArpa).toBe('number');
    expect(typeof m.avgLifespanMonths).toBe('number');
    expect(Array.isArray(m.cohorts)).toBe(true);
    expect(Array.isArray(m.topTenants)).toBe(true);
    expect(m.payingTenants).toBeGreaterThanOrEqual(1);

    // El tenant sembrado aparece en el top con su totalPaid (29 + 29 = 58).
    const mine = m.topTenants.find((t: { tenantId: string }) => t.tenantId === owner.tenantId);
    expect(mine).toBeTruthy();
    expect(mine.totalPaid).toBe(58);
    expect(mine.paymentsCount).toBe(2);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get('/admin/metrics/ltv');
    expect(noAuth.status).toBe(401);
  });
});
