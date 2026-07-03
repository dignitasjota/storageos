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
const ADMIN_EMAIL = 'admin-ovsrc-test@storageos.local';

/**
 * Overrides de feature con `source`: quitar/suspender un add-on NO borra una
 * cortesía manual del admin ni una feature que otro add-on activo sostiene.
 */
describe('Feature overrides con origen (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminToken: string;
  let addonA: string;
  let addonB: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin OvSrc',
        role: 'superadmin',
      },
    });
    await admin.subscriptionAddon.deleteMany({ where: { slug: { startsWith: 'e2e-ovsrc-' } } });
    const a = await admin.subscriptionAddon.create({
      data: { slug: 'e2e-ovsrc-a', name: 'Seguro A', priceMonthly: 10, feature: 'ai_assistant' },
    });
    const b = await admin.subscriptionAddon.create({
      data: { slug: 'e2e-ovsrc-b', name: 'Seguro B', priceMonthly: 20, feature: 'ai_assistant' },
    });
    addonA = a.id;
    addonB = b.id;
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.subscriptionAddon.deleteMany({ where: { slug: { startsWith: 'e2e-ovsrc-' } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  const bearer = () => ({ Authorization: `Bearer ${adminToken}` });

  it('quitar un add-on NO borra la feature si otro add-on activo la sostiene', async () => {
    const owner = await registerVerifiedUser(app, 'ovsrc-dup');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Asigna A y B (ambos aportan 'ai_assistant').
    const rA = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId: addonA, quantity: 1 });
    const assignmentA = rA.body.addons.find((x: { addonId: string }) => x.addonId === addonA)
      .id as string;
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId: addonB, quantity: 1 })
      .expect(201);

    // La feature está activa.
    const me1 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me1.body.features).toContain('ai_assistant');

    // Quita A → B sigue activo → la feature PERMANECE.
    await request(app.getHttpServer())
      .delete(`/admin/tenants/${tenantId}/addons/${assignmentA}`)
      .set(bearer())
      .expect(200);
    const me2 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me2.body.features).toContain('ai_assistant');

    // Al quitar B (el último), la feature YA se retira.
    const rB = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/billing-summary`)
      .set(bearer());
    const assignmentB = rB.body.addons.find((x: { addonId: string }) => x.addonId === addonB)
      .id as string;
    await request(app.getHttpServer())
      .delete(`/admin/tenants/${tenantId}/addons/${assignmentB}`)
      .set(bearer())
      .expect(200);
    const me3 = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me3.body.features).not.toContain('ai_assistant');
  });

  it('quitar un add-on NO borra una cortesía manual del admin sobre la misma feature', async () => {
    const owner = await registerVerifiedUser(app, 'ovsrc-courtesy');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // El admin da 'ai_assistant' de cortesía (override manual).
    await request(app.getHttpServer())
      .put(`/admin/tenants/${tenantId}/features`)
      .set(bearer())
      .send({ overrides: [{ feature: 'ai_assistant', enabled: true }] })
      .expect(200);

    // Asigna y luego quita un add-on que también aporta 'ai_assistant'.
    const rA = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set(bearer())
      .send({ addonId: addonA, quantity: 1 });
    const assignmentA = rA.body.addons.find((x: { addonId: string }) => x.addonId === addonA)
      .id as string;
    await request(app.getHttpServer())
      .delete(`/admin/tenants/${tenantId}/addons/${assignmentA}`)
      .set(bearer())
      .expect(200);

    // La cortesía manual SOBREVIVE (la feature sigue activa).
    const me = await request(app.getHttpServer()).get('/auth/me').set(tenantAuth);
    expect(me.body.features).toContain('ai_assistant');
  });
});
