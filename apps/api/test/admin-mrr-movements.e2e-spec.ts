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

const ADMIN_EMAIL = 'admin-mrr-test@storageos.local';

interface MovementsDto {
  currency: string;
  warmingUp: boolean;
  months: {
    label: string;
    newMrr: number;
    expansion: number;
    contraction: number;
    churn: number;
    net: number;
    endingMrr: number;
    nrr: number | null;
  }[];
}

describe('Admin MRR movements (e2e)', () => {
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
        fullName: 'Admin MRR Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('devuelve la estructura de MRR movements', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/metrics/mrr-movements')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as MovementsDto;
    expect(body.currency).toBe('EUR');
    expect(Array.isArray(body.months)).toBe(true);
    expect(typeof body.warmingUp).toBe('boolean');
    for (const m of body.months) {
      for (const k of ['newMrr', 'expansion', 'contraction', 'churn', 'net', 'endingMrr']) {
        expect(typeof (m as unknown as Record<string, number>)[k]).toBe('number');
      }
    }
  });

  it('detecta expansión entre dos snapshots del mismo tenant', async () => {
    const owner = await registerVerifiedUser(app, 'admin-mrr');
    const now = new Date();
    const m0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const m1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    // Mes anterior: 30 €; mes actual: 50 € → expansión 20 € (el tenant es trial,
    // así que captureMonth no lo toca y respeta estos snapshots).
    await adminClient.mrrSnapshot.create({
      data: { tenantId: owner.tenantId, month: m1, planSlug: 'starter', status: 'active', mrr: 30 },
    });
    await adminClient.mrrSnapshot.create({
      data: { tenantId: owner.tenantId, month: m0, planSlug: 'starter', status: 'active', mrr: 50 },
    });

    const res = await request(app.getHttpServer())
      .get('/admin/metrics/mrr-movements?months=6')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as MovementsDto;
    expect(body.warmingUp).toBe(false);
    const last = body.months[body.months.length - 1]!;
    expect(last.expansion).toBeGreaterThanOrEqual(20);
  });

  it('exige token de super admin', async () => {
    const res = await request(app.getHttpServer()).get('/admin/metrics/mrr-movements');
    expect(res.status).toBe(401);
  });
});
