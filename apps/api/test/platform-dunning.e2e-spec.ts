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
      // El escalado solo actúa sobre tenants operando (no en prueba).
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
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
    // Solo los pasos de ESTE tenant (otras suites pueden dejar morosos).
    const prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    try {
      const steps = await prisma.platformDunningEvent.findMany({ where: { tenantId } });
      expect(steps.map((e) => e.step).sort()).toEqual(['reminder_1', 'reminder_2', 'suspend']);
    } finally {
      await prisma.$disconnect();
    }

    // El tenant quedó suspendido.
    const detail = await request(app.getHttpServer()).get(`/admin/tenants/${tenantId}`).set(auth);
    expect(detail.body.status).toBe('suspended');

    // Re-ejecutar es idempotente (no repite pasos del mismo ciclo).
    await request(app.getHttpServer()).post('/admin/platform-dunning/run').set(auth);
    const prisma2 = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    try {
      expect(await prisma2.platformDunningEvent.count({ where: { tenantId } })).toBe(3);
    } finally {
      await prisma2.$disconnect();
    }
  });

  it('en Stripe cuenta desde el cobro que falló (inicio del periodo), no desde su fin', async () => {
    const owner = await registerVerifiedUser(app, 'dunningstripe');
    const prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const DAY = 24 * 60 * 60 * 1000;
    try {
      // Stripe ya avanzó el periodo al que no se pudo cobrar: empezó hace 5 días
      // y acaba dentro de 25. Antes, «días de impago» salía negativo.
      await prisma.tenantSubscription.update({
        where: { tenantId: owner.tenantId },
        data: {
          status: 'past_due',
          billingMode: 'stripe',
          stripeSubscriptionId: `sub_dunning_${Date.now()}`,
          currentPeriodStart: new Date(Date.now() - 5 * DAY),
          currentPeriodEnd: new Date(Date.now() + 25 * DAY),
          manualExtensionDays: 0,
        },
      });
      await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
      await request(app.getHttpServer()).post('/admin/platform-dunning/run').set(auth).expect(201);
      const events = await prisma.platformDunningEvent.findMany({
        where: { tenantId: owner.tenantId },
      });
      // 5 días: primer recordatorio (3), aún no el segundo (10) ni la suspensión (21).
      expect(events.map((e) => e.step)).toEqual(['reminder_1']);
    } finally {
      await prisma.$disconnect();
    }
  });
});
