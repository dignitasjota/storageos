import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Cleanup cron de `webhook_deliveries` (>30 días) — endpoint admin manual
 * y comportamiento del service. El cron en sí no se ejecuta en tests (lo
 * cubre el path manual via endpoint).
 */
describe('Webhooks cleanup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let tenantId: string;
  let webhookId: string;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

    // Seed: un tenant + un webhook + 4 deliveries (2 recientes, 2 viejos).
    const ids = uniqueTestIds('wh-cleanup');
    const tenant = await prisma.tenant.create({
      data: {
        name: `Test ${ids.slug}`,
        slug: ids.slug,
        status: 'active',
        country: 'ES',
        locale: 'es-ES',
        currency: 'EUR',
        timezone: 'Europe/Madrid',
      },
    });
    tenantId = tenant.id;

    const webhook = await prisma.webhook.create({
      data: {
        tenantId,
        name: 'Test webhook',
        url: 'https://example.com/hook',
        secret: 'encrypted-secret-placeholder',
        events: ['invoice.paid'],
      },
    });
    webhookId = webhook.id;

    const now = Date.now();
    const old1 = new Date(now - 40 * 24 * 60 * 60 * 1000);
    const old2 = new Date(now - 35 * 24 * 60 * 60 * 1000);
    const recent1 = new Date(now - 5 * 24 * 60 * 60 * 1000);
    const recent2 = new Date(now - 1 * 24 * 60 * 60 * 1000);

    for (const created of [old1, old2, recent1, recent2]) {
      await prisma.webhookDelivery.create({
        data: {
          tenantId,
          webhookId,
          eventType: 'invoice.paid',
          payload: { test: true },
          signature: 't=1,v1=fake',
          status: 'success',
          scheduledFor: created,
          createdAt: created,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { webhookId } });
    await prisma.webhook.deleteMany({ where: { id: webhookId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  async function loginAsSuperAdmin(): Promise<string> {
    const admin = await seedSuperAdmin('cleanup');
    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect([200, 201]).toContain(res.status);
    return res.body.accessToken as string;
  }

  it('GET /stats devuelve breakdown + eligibleForCleanup correcto antes de purgar', async () => {
    const token = await loginAsSuperAdmin();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/webhooks-cleanup/stats?olderThanDays=30')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(4);
    expect(res.body.eligibleForCleanup).toBeGreaterThanOrEqual(2);
    expect(res.body.olderThanDays).toBe(30);
    expect(res.body.cutoff).toBeDefined();
    expect(res.body.oldestAt).toBeDefined();
    expect(res.body.newestAt).toBeDefined();
    expect(Array.isArray(res.body.byStatus)).toBe(true);
    expect(res.body.byStatus.some((b: { status: string }) => b.status === 'success')).toBe(true);
  });

  it('GET /stats sin olderThanDays usa el default del env', async () => {
    const token = await loginAsSuperAdmin();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/webhooks-cleanup/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.olderThanDays).toBeGreaterThan(0);
  });

  it('GET /stats sin Authorization responde 401', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/webhooks-cleanup/stats');
    expect(res.status).toBe(401);
  });

  it('cleanup con olderThanDays=30 borra los 2 deliveries antiguos y conserva los 2 recientes', async () => {
    const token = await loginAsSuperAdmin();
    const res = await request(app.getHttpServer())
      .post('/v1/admin/webhooks-cleanup/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ olderThanDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(res.body.olderThanDays).toBe(30);

    const remaining = await prisma.webhookDelivery.count({ where: { webhookId } });
    expect(remaining).toBe(2);
  });

  it('cleanup con olderThanDays no especificado usa el default del env', async () => {
    const token = await loginAsSuperAdmin();
    // En este punto solo quedan los 2 recientes (< 30d), así que ninguno debería borrarse.
    const res = await request(app.getHttpServer())
      .post('/v1/admin/webhooks-cleanup/run')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
    expect(res.body.olderThanDays).toBeGreaterThan(0);
  });

  it('cleanup con olderThanDays=0 o negativo es rechazado por validación Zod', async () => {
    const token = await loginAsSuperAdmin();
    const res = await request(app.getHttpServer())
      .post('/v1/admin/webhooks-cleanup/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ olderThanDays: 0 });

    expect(res.status).toBe(400);
  });

  it('sin Authorization el endpoint responde 401', async () => {
    const res = await request(app.getHttpServer()).post('/v1/admin/webhooks-cleanup/run').send({});
    expect(res.status).toBe(401);
  });

  it('con bearer de tenant (no super admin) responde 401', async () => {
    // Un JWT de tenant no autenticará como super admin (purpose != 'superadmin').
    const res = await request(app.getHttpServer())
      .post('/v1/admin/webhooks-cleanup/run')
      .set('Authorization', 'Bearer fake-tenant-jwt')
      .send({});
    expect(res.status).toBe(401);
  });
});
