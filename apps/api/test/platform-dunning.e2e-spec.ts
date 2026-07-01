import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgresql://storageos:storageos@localhost:5432/storageos?schema=public';

/**
 * Dunning del SaaS: un tenant con la suscripción `past_due` y muchos días de
 * impago recibe recordatorios y se suspende al ejecutar el dunning. Idempotente.
 */
describe('Dunning del SaaS (e2e)', () => {
  let app: INestApplication;
  let auth: { Authorization: string };
  let tenantId: string;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();

    const owner = await registerVerifiedUser(app, 'dunning');
    tenantId = owner.tenantId;

    const admin = await seedSuperAdmin('dunning');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };

    // Marcar la suscripción como past_due con el periodo vencido hace 25 días.
    const prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    try {
      const overdue = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { status: 'past_due', currentPeriodEnd: overdue, manualExtensionDays: 0 },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('recuerda y suspende al moroso; idempotente', async () => {
    // Activar el dunning (recordatorios a 3 y 10 días, suspensión a 21).
    await request(app.getHttpServer())
      .put('/admin/platform-dunning/settings')
      .set(auth)
      .send({ enabled: true, reminder1Days: 3, reminder2Days: 10, suspendDays: 21 })
      .expect(200);

    // Ejecutar: 25 días de impago supera los 3 umbrales → 2 recordatorios + 1 suspensión.
    const run1 = await request(app.getHttpServer()).post('/admin/platform-dunning/run').set(auth);
    expect(run1.status).toBe(201);
    expect(run1.body.evaluated).toBeGreaterThanOrEqual(1);
    expect(run1.body.reminders).toBe(2);
    expect(run1.body.suspended).toBe(1);

    // El tenant quedó suspendido.
    const detail = await request(app.getHttpServer()).get(`/admin/tenants/${tenantId}`).set(auth);
    expect(detail.body.status).toBe('suspended');

    // Re-ejecutar es idempotente (no repite pasos del mismo ciclo).
    const run2 = await request(app.getHttpServer()).post('/admin/platform-dunning/run').set(auth);
    expect(run2.body.reminders).toBe(0);
    expect(run2.body.suspended).toBe(0);
  });
});
