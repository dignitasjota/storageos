import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { FeatureExpiryService } from '../src/modules/admin/feature-expiry.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-ft-test@storageos.local';

describe('Admin: pruebas gratis de extras y cortesías con fecha (e2e)', () => {
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
        fullName: 'Admin FT Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  const DAY = 86_400_000;

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const addon = await adminClient.subscriptionAddon.upsert({
      where: { slug: `e2e-ft-${suffix}` },
      update: {},
      create: {
        slug: `e2e-ft-${suffix}`,
        name: 'IA de prueba',
        priceMonthly: 12,
        feature: 'ai_assistant',
      },
    });
    return { owner, tenant, addon };
  }

  it('la prueba gratis activa la función y, al contratarla, pasa a ser el extra sin fecha', async () => {
    const { owner, tenant, addon } = await setup('ftconv');
    const admin = { Authorization: `Bearer ${token}` };
    const me = { Authorization: `Bearer ${owner.accessToken}` };

    const started = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addon-trials/${addon.id}`)
      .set(admin)
      .send({ days: 14 })
      .expect(201);
    expect(started.body.feature).toBe('ai_assistant');

    await request(app.getHttpServer()).get('/ai/conversations').set(me).expect(200);
    const features = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenant.id}/features`)
      .set(admin)
      .expect(200);
    expect(features.body.overrides).toEqual([
      expect.objectContaining({
        feature: 'ai_assistant',
        source: 'trial',
        trialAddonName: 'IA de prueba',
      }),
    ]);
    const self = await request(app.getHttpServer())
      .get('/settings/saas-billing/addons')
      .set(me)
      .expect(200);
    expect(self.body.trials).toEqual([{ addonId: addon.id, expiresAt: started.body.expiresAt }]);

    // Lo contrata: deja de ser una prueba. Otra prueba del mismo extra ya no se puede.
    await request(app.getHttpServer())
      .post('/settings/saas-billing/addons')
      .set(me)
      .send({ addonId: addon.id })
      .expect(200);
    const row = await adminClient.tenantFeatureOverride.findUniqueOrThrow({
      where: { tenantId_feature: { tenantId: tenant.id, feature: 'ai_assistant' } },
    });
    expect(row).toMatchObject({ source: 'addon', expiresAt: null, trialAddonId: null });
    const again = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addon-trials/${addon.id}`)
      .set(admin)
      .send({ days: 7 });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('addon_already_assigned');
  });

  it('al vencer deja de contar, se quita, se avisa al tenant y al super admin', async () => {
    const { owner, tenant, addon } = await setup('ftexp');
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addon-trials/${addon.id}`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ days: 7 })
      .expect(201);
    const row = await adminClient.tenantFeatureOverride.update({
      where: { tenantId_feature: { tenantId: tenant.id, feature: 'ai_assistant' } },
      data: { expiresAt: new Date(Date.now() + 2 * DAY) },
    });
    const svc = app.get(FeatureExpiryService);

    // A 2 días: aviso de que termina (una sola vez).
    await svc.run();
    await svc.run();
    const ending = await adminClient.tenantLifecycleEmail.findMany({
      where: { tenantId: tenant.id, type: `feature_trial_ending:${row.id}` },
    });
    expect(ending).toHaveLength(1);

    // Vencida: ya no cuenta aunque la tarea no haya corrido.
    await adminClient.tenantFeatureOverride.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const denied = await request(app.getHttpServer())
      .get('/ai/conversations')
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(denied.status).toBe(403);

    const res = await svc.run();
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect(await adminClient.tenantFeatureOverride.count({ where: { id: row.id } })).toBe(0);
    expect(
      await adminClient.tenantLifecycleEmail.count({
        where: { tenantId: tenant.id, type: `feature_trial_ended:${row.id}` },
      }),
    ).toBe(1);
    expect(
      await adminClient.superAdminNotification.count({
        where: { type: 'feature_trial.ended', link: `/admin/tenants/${tenant.id}` },
      }),
    ).toBe(1);
  });

  it('una cortesía con fecha caduca al acabar ese día y sale en «Hoy»', async () => {
    const { tenant } = await setup('ftcourt');
    const admin = { Authorization: `Bearer ${token}` };
    const until = new Date(Date.now() + 3 * DAY).toLocaleDateString('sv-SE', {
      timeZone: 'Europe/Madrid',
    });
    const res = await request(app.getHttpServer())
      .put(`/admin/tenants/${tenant.id}/features`)
      .set(admin)
      .send({ overrides: [{ feature: 'sepa', enabled: true, expiresAt: until }] })
      .expect(200);
    const o = res.body.overrides.find((x: { feature: string }) => x.feature === 'sepa');
    expect(o.source).toBe('manual');
    expect(o.expiresAt).not.toBeNull();

    const today = await request(app.getHttpServer()).get('/admin/today').set(admin).expect(200);
    expect(
      today.body.expiringOverrides.some(
        (x: { tenantId: string; feature: string }) =>
          x.tenantId === tenant.id && x.feature === 'sepa',
      ),
    ).toBe(true);
  });
});
