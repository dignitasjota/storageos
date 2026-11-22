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

  it('lista la salud por grupos: clientes por defecto y las pruebas con su activación', async () => {
    const owner = await registerVerifiedUser(app, 'admin-health');

    // Por defecto, solo los clientes que pagan: una prueba recién creada no sale.
    const paying = await request(app.getHttpServer())
      .get('/admin/tenants/health')
      .set('Authorization', `Bearer ${token}`);
    expect(paying.status).toBe(200);
    expect(paying.body.segment).toBe('paying');
    expect((paying.body.tenants as HealthDto[]).some((t) => t.tenantId === owner.tenantId)).toBe(
      false,
    );
    expect(typeof paying.body.counts.trial).toBe('number');

    const res = await request(app.getHttpServer())
      .get('/admin/tenants/health?segment=trial')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const mine = (res.body.tenants as HealthDto[]).find((t) => t.tenantId === owner.tenantId);
    expect(mine).toBeTruthy();
    expect(mine!.score).toBeGreaterThanOrEqual(0);
    expect(mine!.score).toBeLessThanOrEqual(100);
    expect(LEVELS).toContain(mine!.level);
    expect(mine!.factors.map((f) => f.key).sort()).toEqual([
      'contract',
      'customer',
      'facility',
      'invoice',
      'team',
      'units',
    ]);

    // Ordenado de menor a mayor puntuación (más urgente primero).
    const scores = (res.body.tenants as HealthDto[]).map((t) => t.score);
    const sorted = [...scores].sort((a, b) => a - b);
    expect(scores).toEqual(sorted);

    // Un grupo que no existe vuelve al de clientes.
    const bad = await request(app.getHttpServer())
      .get('/admin/tenants/health?segment=nada')
      .set('Authorization', `Bearer ${token}`);
    expect(bad.body.segment).toBe('paying');
  });

  it('devuelve la salud de un tenant concreto + 404 si no existe', async () => {
    const owner = await registerVerifiedUser(app, 'admin-health-one');
    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/health`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(owner.tenantId);
    expect(res.body.factors).toHaveLength(6);

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
