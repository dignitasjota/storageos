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
const ADMIN_EMAIL = 'admin-cpv-test@storageos.local';

/**
 * Validaciones de cambio de plan + preview de impacto + guard de updateAddon.
 */
describe('Cambio de plan: validación + preview (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin CPV',
        role: 'superadmin',
      },
    });
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-cpv-ai' } });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-cpv-ai' } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  const bearer = () => ({ Authorization: `Bearer ${adminToken}` });

  it('el preview reporta delta de precio, add-ons redundantes y downgrade', async () => {
    const owner = await registerVerifiedUser(app, 'cpv-preview');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Add-on con feature 'ai_assistant', que el plan `pro` SÍ incluye.
    const addon = await admin.subscriptionAddon.create({
      data: { slug: 'e2e-cpv-ai', name: 'Asistente IA', priceMonthly: 12, feature: 'ai_assistant' },
    });
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId: addon.id, quantity: 1 })
      .expect(201);

    // Preview: starter → pro (upgrade). El add-on ai_assistant queda redundante.
    const preview = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/change-plan-preview?planSlug=pro`)
      .set(bearer());
    expect(preview.status).toBe(200);
    expect(preview.body.currentPlanName).toBeTruthy();
    expect(preview.body.newPlanName).toBeTruthy();
    expect(preview.body.isDowngrade).toBe(false); // starter → pro es más caro
    expect(preview.body.redundantAddons.map((a: { feature: string }) => a.feature)).toContain(
      'ai_assistant',
    );
  });

  it('cambiar a un plan desactivado → 400 plan_not_active', async () => {
    const owner = await registerVerifiedUser(app, 'cpv-inactive');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });

    // Crear un plan desactivado.
    await admin.subscriptionPlan.deleteMany({ where: { slug: 'e2e-cpv-off' } });
    await admin.subscriptionPlan.create({
      data: {
        slug: 'e2e-cpv-off',
        name: 'Plan Off',
        priceMonthly: 5,
        priceYearly: 50,
        isActive: false,
      },
    });

    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant!.id}/change-plan`)
      .set(bearer())
      .send({ planSlug: 'e2e-cpv-off', reason: 'prueba' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('plan_not_active');

    await admin.subscriptionPlan.deleteMany({ where: { slug: 'e2e-cpv-off' } });
  });

  it('no se puede cambiar la feature de un add-on ya asignado → 400 addon_feature_locked', async () => {
    const owner = await registerVerifiedUser(app, 'cpv-lock');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });

    const created = await request(app.getHttpServer())
      .post('/admin/addons')
      .set(bearer())
      .send({ slug: 'e2e-cpv-lock', name: 'Lock', priceMonthly: 9, feature: 'sepa' });
    const addonId = created.body.id as string;
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant!.id}/addons`)
      .set(bearer())
      .send({ addonId, quantity: 1 })
      .expect(201);

    // Cambiar la feature con el add-on asignado → 400.
    const upd = await request(app.getHttpServer())
      .patch(`/admin/addons/${addonId}`)
      .set(bearer())
      .send({ slug: 'e2e-cpv-lock', name: 'Lock', priceMonthly: 9, feature: 'insurance' });
    expect(upd.status).toBe(400);
    expect(upd.body.code).toBe('addon_feature_locked');

    // Cambiar el PRECIO (no la feature) sí se permite.
    await request(app.getHttpServer())
      .patch(`/admin/addons/${addonId}`)
      .set(bearer())
      .send({ slug: 'e2e-cpv-lock', name: 'Lock', priceMonthly: 11, feature: 'sepa' })
      .expect(200);

    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-cpv-lock' } });
  });
});
