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

const ADMIN_EMAIL = 'admin-op-test@storageos.local';

describe('Admin: señales de interés, oportunidades y propuestas (e2e)', () => {
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
        fullName: 'Admin OP Test',
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

  it('el interés del tenant se apunta (una vez por hora), avisa al tercer día y sale en oportunidades', async () => {
    const owner = await registerVerifiedUser(app, 'adminop');
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const me = { Authorization: `Bearer ${owner.accessToken}` };
    const addon = await adminClient.subscriptionAddon.upsert({
      where: { slug: 'e2e-op-sepa' },
      update: { isActive: true },
      create: { slug: 'e2e-op-sepa', name: 'Remesas SEPA (e2e)', priceMonthly: 9, feature: 'sepa' },
    });

    const first = await request(app.getHttpServer())
      .post('/feature-interest')
      .set(me)
      .send({ feature: 'sepa', path: '/sepa-remittances' })
      .expect(200);
    expect(first.body.recorded).toBe(true);
    const dup = await request(app.getHttpServer())
      .post('/feature-interest')
      .set(me)
      .send({ feature: 'sepa' })
      .expect(200);
    expect(dup.body.recorded).toBe(false);

    // Una función que ya tiene no cuenta como interés (starter incluye ECRI).
    const owned = await request(app.getHttpServer())
      .post('/feature-interest')
      .set(me)
      .send({ feature: 'rent_increases' })
      .expect(200);
    expect(owned.body.recorded).toBe(false);

    // Dos entradas más (de días anteriores) → aviso al super admin al llegar a 3.
    const user = await adminClient.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await adminClient.featureInterestEvent.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        feature: 'sepa',
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    await adminClient.featureInterestEvent.updateMany({
      where: {
        tenantId: tenant.id,
        feature: 'sepa',
        createdAt: { gt: new Date(Date.now() - 3_600_000) },
      },
      data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    await request(app.getHttpServer())
      .post('/feature-interest')
      .set(me)
      .send({ feature: 'sepa' })
      .expect(200);
    expect(
      await adminClient.superAdminNotification.count({
        where: { type: 'feature_interest', link: `/admin/tenants/${tenant.id}?interest=sepa` },
      }),
    ).toBe(1);

    const ops = await request(app.getHttpServer())
      .get('/admin/opportunities')
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    const sepa = ops.body.find((o: { addonId: string }) => o.addonId === addon.id);
    const cand = sepa.candidates.find((c: { tenantId: string }) => c.tenantId === tenant.id);
    expect(cand.interestCount).toBe(3);
    expect(cand.reasons[0]).toContain('Ha entrado 3 veces');
  });

  it('proponer un extra: correo, prueba gratis, conversación, seguimiento y queda marcado', async () => {
    const owner = await registerVerifiedUser(app, 'adminprop');
    const tenant = await adminClient.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const addon = await adminClient.subscriptionAddon.upsert({
      where: { slug: 'e2e-op-ai' },
      update: { isActive: true },
      create: { slug: 'e2e-op-ai', name: 'IA (e2e)', priceMonthly: 12, feature: 'ai_assistant' },
    });
    const admin = { Authorization: `Bearer ${token}` };

    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addon-offers`)
      .set(admin)
      .send({
        addonId: addon.id,
        message: 'Hola, te puede venir bien.',
        trialDays: 14,
        followupDays: 7,
      })
      .expect(201);
    expect(res.body.recipients).toBe(1);
    expect(res.body.trialExpiresAt).not.toBeNull();
    expect(res.body.followupId).not.toBeNull();

    const override = await adminClient.tenantFeatureOverride.findUniqueOrThrow({
      where: { tenantId_feature: { tenantId: tenant.id, feature: 'ai_assistant' } },
    });
    expect(override.source).toBe('trial');
    expect(
      await adminClient.tenantInteraction.count({
        where: { tenantId: tenant.id, content: { contains: 'IA (e2e)' } },
      }),
    ).toBe(1);
    expect(
      await adminClient.tenantLifecycleEmail.count({
        where: { tenantId: tenant.id, type: { startsWith: 'addon_offer:' } },
      }),
    ).toBe(1);
    const ops = await request(app.getHttpServer())
      .get('/admin/opportunities')
      .set(admin)
      .expect(200);
    // Con la prueba activa ya tiene la función: deja de ser candidato.
    const ai = ops.body.find((o: { addonId: string }) => o.addonId === addon.id);
    expect(
      ai?.candidates.some((c: { tenantId: string }) => c.tenantId === tenant.id) ?? false,
    ).toBe(false);

    await request(app.getHttpServer())
      .post('/feature-interest')
      .send({ feature: 'sepa' })
      .expect(401);
  });
});
