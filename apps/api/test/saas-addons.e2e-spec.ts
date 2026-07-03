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
const ADMIN_EMAIL = 'admin-addons-test@storageos.local';

/**
 * Motor de add-ons facturables del SaaS: catálogo (super admin) + asignación por
 * tenant + activación de feature (override) + reflejo en el MRR/facturación.
 */
describe('SaaS add-ons (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let adminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Addons Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.subscriptionAddon.deleteMany({ where: { slug: { startsWith: 'e2e-' } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  const bearer = () => ({ Authorization: `Bearer ${adminToken}` });

  it('catálogo: crear + validar feature + slug único', async () => {
    const create = await request(app.getHttpServer()).post('/admin/addons').set(bearer()).send({
      slug: 'e2e-domain',
      name: 'Dominio propio',
      priceMonthly: 15,
      feature: 'custom_domain',
    });
    expect(create.status).toBe(201);
    expect(create.body.feature).toBe('custom_domain');

    // Slug repetido → 400.
    await request(app.getHttpServer())
      .post('/admin/addons')
      .set(bearer())
      .send({ slug: 'e2e-domain', name: 'Otro', priceMonthly: 5 })
      .expect(400);

    // Feature desconocida → 400.
    await request(app.getHttpServer())
      .post('/admin/addons')
      .set(bearer())
      .send({ slug: 'e2e-bad', name: 'Malo', priceMonthly: 5, feature: 'no_existe' })
      .expect(400);
  });

  it('asignar a un tenant activa la feature y suma al importe efectivo; quitar lo revierte', async () => {
    // Add-on vinculado a la feature custom_domain.
    const addon = await request(app.getHttpServer()).post('/admin/addons').set(bearer()).send({
      slug: 'e2e-domain2',
      name: 'Dominio propio',
      priceMonthly: 15,
      feature: 'custom_domain',
    });
    const addonId = addon.body.id as string;

    // Tenant en starter (que NO incluye custom_domain).
    const owner = await registerVerifiedUser(app, 'addons-t');
    const tenant = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Antes: /auth/me del tenant NO trae custom_domain.
    const before = await request(app.getHttpServer())
      .get('/auth/me')
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(before.body.features).not.toContain('custom_domain');

    // Asignar el add-on.
    const assign = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId, quantity: 1 });
    expect(assign.status).toBe(201);
    expect(assign.body.addonsMonthly).toBe(15);
    expect(assign.body.effectiveMonthly).toBe(assign.body.planMonthly + 15);
    const assignmentId = assign.body.addons[0].id as string;

    // El override activó la feature: el tenant ya la ve (tras re-login/me).
    const overrides = await adminClient.tenantFeatureOverride.findMany({
      where: { tenantId, feature: 'custom_domain', enabled: true },
    });
    expect(overrides).toHaveLength(1);

    // Quitar el add-on → revierte el override + baja el importe.
    const removed = await request(app.getHttpServer())
      .delete(`/admin/tenants/${tenantId}/addons/${assignmentId}`)
      .set(bearer());
    expect(removed.status).toBe(200);
    expect(removed.body.addonsMonthly).toBe(0);
    const after = await adminClient.tenantFeatureOverride.findMany({
      where: { tenantId, feature: 'custom_domain' },
    });
    expect(after).toHaveLength(0);
  });

  it('suspender por impago: desactiva la feature y no cuenta al total; reactivar la restaura', async () => {
    const owner = await registerVerifiedUser(app, 'addon-suspend');
    const tenant = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };

    // Crear un add-on con feature y asignarlo → feature activa.
    const addon = await request(app.getHttpServer()).post('/admin/addons').set(bearer()).send({
      slug: 'e2e-suspend-ai',
      name: 'Asistente IA',
      priceMonthly: 12,
      feature: 'ai_assistant',
    });
    const assigned = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId: addon.body.id, quantity: 1 });
    expect(assigned.body.addonsMonthly).toBe(12);
    const assignmentId = assigned.body.addons[0].id as string;

    const me1 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me1.body.features).toContain('ai_assistant');

    // Suspender → feature off + no cuenta al total, pero el add-on sigue listado.
    const suspended = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/suspend`)
      .set(bearer());
    expect(suspended.status).toBe(201);
    expect(suspended.body.addonsMonthly).toBe(0);
    expect(suspended.body.addons).toHaveLength(1);
    expect(suspended.body.addons[0].suspended).toBe(true);

    const me2 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me2.body.features).not.toContain('ai_assistant');

    // Doble suspensión → 400.
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/suspend`)
      .set(bearer())
      .expect(400);

    // Reactivar → feature de nuevo + vuelve a contar.
    const reactivated = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/reactivate`)
      .set(bearer());
    expect(reactivated.status).toBe(201);
    expect(reactivated.body.addonsMonthly).toBe(12);
    expect(reactivated.body.addons[0].suspended).toBe(false);

    const me3 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me3.body.features).toContain('ai_assistant');

    await adminClient.subscriptionAddon.deleteMany({ where: { slug: 'e2e-suspend-ai' } });
  });

  it('el tenant ve el estado de pago pendiente cuando un add-on está suspendido', async () => {
    const owner = await registerVerifiedUser(app, 'billing-status');
    const tenant = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin nada suspendido → sin aviso.
    const clean = await request(app.getHttpServer())
      .get('/settings/billing-status')
      .set(tenantAuth);
    expect(clean.status).toBe(200);
    expect(clean.body.hasIssue).toBe(false);

    // Asignar + suspender un add-on con feature.
    const addon = await request(app.getHttpServer())
      .post('/admin/addons')
      .set(bearer())
      .send({ slug: 'e2e-bs-ai', name: 'Asistente IA', priceMonthly: 12, feature: 'ai_assistant' });
    const assigned = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId: addon.body.id, quantity: 1 });
    const assignmentId = assigned.body.addons[0].id as string;
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons/${assignmentId}/suspend`)
      .set(bearer())
      .expect(201);

    // El tenant ve el aviso + la feature suspendida.
    const issue = await request(app.getHttpServer())
      .get('/settings/billing-status')
      .set(tenantAuth);
    expect(issue.body.hasIssue).toBe(true);
    expect(issue.body.suspendedFeatures).toContain('ai_assistant');
    expect(issue.body.suspendedAddons[0].name).toBe('Asistente IA');

    await adminClient.subscriptionAddon.deleteMany({ where: { slug: 'e2e-bs-ai' } });
  });

  it('sin token de super admin → 401', async () => {
    await request(app.getHttpServer()).get('/admin/addons').expect(401);
  });
});
