import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-critfix-test@storageos.local';

/**
 * Fixes críticos de la capa de facturación SaaS:
 * - un tenant no puede reactivar/cancelar por self-service un add-on suspendido;
 * - un cobro de add-on desde el «Hoy» falla si el add-on está suspendido;
 * - un pago que regulariza la suscripción reactiva el tenant suspendido por dunning.
 */
describe('Fixes críticos de facturación SaaS (e2e)', () => {
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
        fullName: 'Admin CritFix',
        role: 'superadmin',
      },
    });
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-crit-ai' } });
    const addon = await admin.subscriptionAddon.create({
      data: {
        slug: 'e2e-crit-ai',
        name: 'Asistente IA',
        priceMonthly: 12,
        feature: 'ai_assistant',
      },
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
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-crit-ai' } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  const bearer = () => ({ Authorization: `Bearer ${adminToken}` });

  it('el tenant NO puede self-reactivar ni self-cancelar un add-on suspendido (escape de deuda)', async () => {
    const owner = await registerVerifiedUser(app, 'crit-escape');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Asignar + suspender el add-on.
    const assigned = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId, quantity: 1 });
    const assignmentId = assigned.body.addons[0].id as string;
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/suspend`)
      .set(bearer())
      .expect(201);

    // Self-reactivar (re-contratar) → 400 addon_suspended.
    const reassign = await request(app.getHttpServer())
      .post('/settings/saas-billing/addons')
      .set(tenantAuth)
      .send({ addonId });
    expect(reassign.status).toBe(400);
    expect(reassign.body.code).toBe('addon_suspended');

    // Self-cancelar (borrar la deuda) → 400 addon_suspended.
    const cancel = await request(app.getHttpServer())
      .delete(`/settings/saas-billing/addons/${assignmentId}`)
      .set(tenantAuth);
    expect(cancel.status).toBe(400);
    expect(cancel.body.code).toBe('addon_suspended');

    // Sigue suspendido (la feature no volvió).
    const me = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me.body.features).not.toContain('ai_assistant');
  });

  it('cobrar desde el «Hoy» un add-on ya suspendido → 400 addon_suspended', async () => {
    const owner = await registerVerifiedUser(app, 'crit-charge');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;
    await admin.tenantSubscription.update({
      where: { tenantId },
      data: { stripeSubscriptionId: `sub_crit_${Date.now()}` },
    });
    const assigned = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId, quantity: 1 });
    const assignmentId = assigned.body.addons[0].id as string;
    // Suspender y luego intentar cobrar por el endpoint del «Hoy».
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/suspend`)
      .set(bearer())
      .expect(201);
    const charge = await request(app.getHttpServer())
      .post(`/admin/today/addon-charges/${assignmentId}/charge`)
      .set(bearer())
      .send({ provider: 'cash' });
    expect(charge.status).toBe(400);
    expect(charge.body.code).toBe('addon_suspended');
  });

  it('un pago manual que regulariza la suscripción reactiva el tenant suspendido por dunning', async () => {
    const owner = await registerVerifiedUser(app, 'crit-reactivate');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Simular el estado post-dunning: sub past_due + tenant suspended.
    await admin.tenantSubscription.update({
      where: { tenantId },
      data: { status: 'past_due' },
    });
    await admin.tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } });

    // Pago manual con extensión (regulariza).
    const billing = app.get(BillingSaasService, { strict: false });
    await billing.recordManualPayment({
      tenantId,
      provider: 'bank_transfer',
      amount: 49,
      currency: 'EUR',
      durationMonths: 1,
      extendsPeriod: true,
    });

    const after = await admin.tenant.findUnique({ where: { id: tenantId } });
    const sub = await admin.tenantSubscription.findUnique({ where: { tenantId } });
    expect(after!.status).toBe('active');
    expect(sub!.status).toBe('active');
  });
});
