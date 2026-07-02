import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-domain-test@storageos.local';

/**
 * White-label por dominio propio (PR 1): configuración por el tenant (gated por
 * plan), unicidad, y activación/revocación + resolución por el super admin.
 */
describe('Dominio propio del tenant (e2e)', () => {
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
        fullName: 'Admin Domain Test',
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
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('gating por plan: un tenant sin la feature no puede fijar dominio', async () => {
    const owner = await registerVerifiedUser(app, 'domain-free');
    await setTenantPlan(owner.slug, 'free');
    const res = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ customDomain: 'trasteros-free.com' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('feature_not_in_plan');
  });

  it('ciclo completo: configurar (pro) → pending → activar → resolver → revocar', async () => {
    const owner = await registerVerifiedUser(app, 'domain-pro');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const domain = 'trasteros-pro.example';

    // El tenant fija su dominio → queda pendiente (verifiedAt null).
    const set = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ customDomain: domain });
    expect(set.status).toBe(200);
    expect(set.body.customDomain).toBe(domain);
    expect(set.body.customDomainVerifiedAt).toBeNull();

    // Aún no verificado → resolve-domain 404.
    await request(app.getHttpServer())
      .get('/public/landing/resolve-domain')
      .query({ host: domain })
      .expect(404);

    // Aparece en la cola del super admin como pendiente.
    const queue = await request(app.getHttpServer())
      .get('/admin/tenants/custom-domains')
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(queue.status).toBe(200);
    const entry = (queue.body as { customDomain: string; verifiedAt: string | null }[]).find(
      (d) => d.customDomain === domain,
    );
    expect(entry).toBeTruthy();
    expect(entry!.verifiedAt).toBeNull();

    // Buscar el tenantId por su slug para activarlo.
    const tenantRow = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });
    const verify = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantRow!.id}/custom-domain/verify`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(verify.status).toBe(200);
    expect(verify.body.verifiedAt).not.toBeNull();

    // Ya verificado → resolve-domain devuelve el slug.
    const resolved = await request(app.getHttpServer())
      .get('/public/landing/resolve-domain')
      .query({ host: domain });
    expect(resolved.status).toBe(200);
    expect(resolved.body.tenantSlug).toBe(owner.slug);

    // Y la landing pública expone el dominio activo (para el canonical).
    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.body.customDomain).toBe(domain);

    // Revocar → deja de resolver.
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantRow!.id}/custom-domain/revoke`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);
    await request(app.getHttpServer())
      .get('/public/landing/resolve-domain')
      .query({ host: domain })
      .expect(404);
  });

  it('unicidad: otro tenant no puede reclamar el mismo dominio', async () => {
    const a = await registerVerifiedUser(app, 'domain-uniq-a');
    const b = await registerVerifiedUser(app, 'domain-uniq-b');
    await setTenantPlan(a.slug, 'pro');
    await setTenantPlan(b.slug, 'pro');
    const domain = 'compartido.example';

    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${a.accessToken}` })
      .send({ customDomain: domain })
      .expect(200);

    const clash = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${b.accessToken}` })
      .send({ customDomain: domain });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('domain_taken');
  });

  it('valida el formato del dominio (400)', async () => {
    const owner = await registerVerifiedUser(app, 'domain-bad');
    await setTenantPlan(owner.slug, 'pro');
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ customDomain: 'no-es-un-dominio' })
      .expect(400);
  });
});
