import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-system-test@storageos.local';

describe('Admin system health + queue actions (e2e)', () => {
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
        fullName: 'Admin System Test',
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

  it('reporta la salud del sistema (Postgres/Redis/MinIO/worker)', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/system-health')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('checkedAt');
    const keys = res.body.services.map((s: { key: string }) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['database', 'redis', 'minio', 'worker']));
    const db = res.body.services.find((s: { key: string }) => s.key === 'database');
    expect(db.status).toBe('up'); // Postgres siempre disponible en el entorno de test

    const noAuth = await request(app.getHttpServer()).get('/admin/system-health');
    expect(noAuth.status).toBe(401);
  });

  it('reintenta y limpia los jobs fallidos de una cola', async () => {
    const retry = await request(app.getHttpServer())
      .post('/admin/queues/billing/retry-failed')
      .set('Authorization', `Bearer ${token}`);
    expect(retry.status).toBe(200);
    expect(typeof retry.body.retried).toBe('number');

    const clean = await request(app.getHttpServer())
      .post('/admin/queues/billing/clean-failed')
      .set('Authorization', `Bearer ${token}`);
    expect(clean.status).toBe(200);
    expect(typeof clean.body.cleaned).toBe('number');

    // Cola inexistente -> 404
    const ghost = await request(app.getHttpServer())
      .post('/admin/queues/nope/retry-failed')
      .set('Authorization', `Bearer ${token}`);
    expect(ghost.status).toBe(404);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).post('/admin/queues/billing/retry-failed');
    expect(noAuth.status).toBe(401);
  });
});
