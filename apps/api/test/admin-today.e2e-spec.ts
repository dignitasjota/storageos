import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-today-test@storageos.local';

/**
 * Bandeja «Hoy» del super admin: los cobros de add-ons pendientes (de tenants
 * que pagan el plan por Stripe) aparecen y se cobran sin extender el periodo.
 */
describe('Admin «Hoy» (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminToken: string;
  let addonId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Today',
        role: 'superadmin',
      },
    });
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-today-ai' } });
    const addon = await admin.subscriptionAddon.create({
      data: { slug: 'e2e-today-ai', name: 'Asistente IA', priceMonthly: 12, isActive: true },
    });
    addonId = addon.id;
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-today-ai' } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('lista el cobro de add-on pendiente y lo cobra sin extender el periodo', async () => {
    const owner = await registerVerifiedUser(app, 'today-addon');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // El tenant paga el plan por Stripe (condición para el recordatorio de add-on).
    const subBefore = await admin.tenantSubscription.update({
      where: { tenantId },
      data: { stripeSubscriptionId: `sub_today_${Date.now()}` },
    });
    const periodEndBefore = subBefore.currentPeriodEnd.getTime();

    // Asignar el add-on → programa su primer cobro para ya.
    const assign = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(auth)
      .send({ addonId, quantity: 1 });
    expect(assign.status).toBe(201);

    // Aparece en la bandeja «Hoy».
    const today1 = await request(app.getHttpServer()).get('/admin/today').set(auth);
    expect(today1.status).toBe(200);
    const due = today1.body.addonCharges.find((c: { tenantId: string }) => c.tenantId === tenantId);
    expect(due).toBeTruthy();
    expect(due.amount).toBe(12);
    expect(today1.body.urgentCount).toBeGreaterThanOrEqual(1);

    // Cobrarlo → registra el pago y reprograma el siguiente en un mes.
    const charged = await request(app.getHttpServer())
      .post(`/admin/today/addon-charges/${due.tenantAddonId}/charge`)
      .set(auth)
      .send({ provider: 'cash' });
    expect(charged.status).toBe(201);
    // Ya no está pendiente (next_charge_at movido a +1 mes).
    expect(
      charged.body.addonCharges.find((c: { tenantId: string }) => c.tenantId === tenantId),
    ).toBeUndefined();

    // El pago se registró SIN extender el periodo del plan.
    const subAfter = await admin.tenantSubscription.findUnique({ where: { tenantId } });
    expect(subAfter!.currentPeriodEnd.getTime()).toBe(periodEndBefore);

    const payments = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/saas-payments`)
      .set(auth);
    expect(payments.body.some((p: { amount: number }) => p.amount === 12)).toBe(true);
  });

  it('lista renovaciones manuales por expirar y add-ons suspendidos hace tiempo', async () => {
    const owner = await registerVerifiedUser(app, 'today-renew');
    const auth = { Authorization: `Bearer ${adminToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Suscripción de pago manual (sin Stripe) que vence en 3 días.
    const in3d = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    await admin.tenantSubscription.update({
      where: { tenantId },
      data: { stripeSubscriptionId: null, status: 'active', currentPeriodEnd: in3d },
    });

    // Add-on suspendido hace 40 días.
    const assigned = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(auth)
      .send({ addonId, quantity: 1 });
    const assignmentId = assigned.body.addons[0].id as string;
    await admin.tenantSubscriptionAddon.update({
      where: { id: assignmentId },
      data: { suspendedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) },
    });

    const today = await request(app.getHttpServer()).get('/admin/today').set(auth);
    expect(today.status).toBe(200);
    const renewal = today.body.manualRenewalsDue.find(
      (r: { tenantId: string }) => r.tenantId === tenantId,
    );
    expect(renewal).toBeTruthy();
    expect(renewal.daysLeft).toBeGreaterThanOrEqual(2);
    expect(renewal.daysLeft).toBeLessThanOrEqual(3);

    const stale = today.body.staleSuspendedAddons.find(
      (s: { tenantId: string }) => s.tenantId === tenantId,
    );
    expect(stale).toBeTruthy();
    expect(stale.daysSuspended).toBeGreaterThanOrEqual(39);

    // Triaje añadido: tickets sin responder + jobs de colas fallidos.
    expect(Array.isArray(today.body.openTickets)).toBe(true);
    expect(typeof today.body.failedJobs).toBe('number');
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/today').expect(401);
  });
});
