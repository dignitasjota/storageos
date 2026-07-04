import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-forecast-test@storageos.local';

/** Previsión de MRR del SaaS. */
describe('Forecast MRR (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Forecast',
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
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('proyecta el horizonte pedido con los supuestos transparentes', async () => {
    const bearer = { Authorization: `Bearer ${token}` };

    const res = await request(app.getHttpServer())
      .get('/admin/metrics/mrr-forecast?months=6')
      .set(bearer);
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('EUR');
    expect(typeof res.body.currentMrr).toBe('number');
    expect(typeof res.body.warmingUp).toBe('boolean');
    // Un punto por mes del horizonte.
    expect(res.body.points).toHaveLength(6);
    for (const p of res.body.points) {
      expect(typeof p.label).toBe('string');
      expect(typeof p.mrr).toBe('number');
      expect(p.mrr).toBeGreaterThanOrEqual(0); // el MRR proyectado nunca es negativo
    }
    // Supuestos expuestos.
    expect(res.body.assumptions).toBeDefined();
    expect(typeof res.body.assumptions.avgNewMrr).toBe('number');
    expect(typeof res.body.assumptions.basedOnMonths).toBe('number');

    // El horizonte es configurable (se acota).
    const res3 = await request(app.getHttpServer())
      .get('/admin/metrics/mrr-forecast?months=3')
      .set(bearer);
    expect(res3.body.points).toHaveLength(3);
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/metrics/mrr-forecast').expect(401);
  });
});
