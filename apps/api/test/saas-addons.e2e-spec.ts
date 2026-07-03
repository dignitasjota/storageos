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

  it('sin token de super admin → 401', async () => {
    await request(app.getHttpServer()).get('/admin/addons').expect(401);
  });
});
