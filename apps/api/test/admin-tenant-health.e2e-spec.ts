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

const ADMIN_EMAIL = 'admin-health-test@storageos.local';

interface HealthDto {
  tenantId: string;
  score: number;
  level: string;
  factors: { key: string; label: string; score: number; weight: number; detail: string }[];
}

describe('Admin tenant health score (e2e)', () => {
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
        fullName: 'Admin Health Test',
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

  const LEVELS = ['healthy', 'warm', 'at_risk', 'dormant'];

  it('lista la salud de los tenants con score 0-100, nivel y 4 factores', async () => {
    const owner = await registerVerifiedUser(app, 'admin-health');

    const res = await request(app.getHttpServer())
      .get('/admin/tenants/health')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const mine = (res.body as HealthDto[]).find((t) => t.tenantId === owner.tenantId);
    expect(mine).toBeTruthy();
    expect(mine!.score).toBeGreaterThanOrEqual(0);
    expect(mine!.score).toBeLessThanOrEqual(100);
    expect(LEVELS).toContain(mine!.level);
    expect(mine!.factors.map((f) => f.key).sort()).toEqual([
      'adoption',
      'billing',
      'engagement',
      'subscription',
    ]);

    // Ordenado de menor a mayor score (más urgente primero).
    const scores = (res.body as HealthDto[]).map((t) => t.score);
    const sorted = [...scores].sort((a, b) => a - b);
    expect(scores).toEqual(sorted);
  });

  it('devuelve la salud de un tenant concreto + 404 si no existe', async () => {
    const owner = await registerVerifiedUser(app, 'admin-health-one');
    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/health`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(owner.tenantId);
    expect(res.body.factors).toHaveLength(4);

    const ghost = await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-7000-8000-000000000000/health')
      .set('Authorization', `Bearer ${token}`);
    expect(ghost.status).toBe(404);
  });

  it('exige token de super admin', async () => {
    const res = await request(app.getHttpServer()).get('/admin/tenants/health');
    expect(res.status).toBe(401);
  });
});
