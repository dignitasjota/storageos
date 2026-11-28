import { hash as argonHash } from '@node-rs/argon2';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import {
  cleanupTestTenants,
  cleanupTenantsById,
  setTenantPlan,
  setVerifiedCustomDomain,
  uniqueTestIds,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Subdominios `<slug>.<plataforma>` de los negocios (SEO web D4): identificadores
 * reservados, qué sirve cada subdominio y la cola de «por crear en el proxy»
 * del panel admin (marcar como hecho solo superadmin).
 */
describe('Subdominios de la plataforma (e2e)', () => {
  let app: INestApplication;
  let superToken: string;
  let supportToken: string;
  let superEmail: string;
  let supportEmail: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    const sa = await seedSuperAdmin('subdomain');
    superEmail = sa.email;
    supportEmail = `test-2fa-subdomain-support-${Date.now().toString(36)}@storageos.local`;
    const passwordHash = await argonHash('AdminTest!23');
    await withAdminDb((db) =>
      db.superAdmin.create({
        data: {
          email: supportEmail,
          passwordHash,
          fullName: 'Soporte subdominios',
          role: 'support',
        },
      }),
    );
    superToken = (
      await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: superEmail, password: sa.password })
    ).body.accessToken;
    supportToken = (
      await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: supportEmail, password: 'AdminTest!23' })
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await withAdminDb((db) => db.superAdmin.deleteMany({ where: { email: supportEmail } }));
    await cleanupSuperAdmins();
    await cleanupTenantsById(createdIds);
    await cleanupTestTenants();
  });

  const resolve = (slug: string) =>
    request(app.getHttpServer()).get('/public/landing/resolve-subdomain').query({ slug });

  it('no admite un identificador reservado al darse de alta', async () => {
    const ids = uniqueTestIds('reserved');
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Reservado Prueba',
      tenantSlug: 'api',
      fullName: 'Test User',
      email: ids.email,
      password: 'Secret123',
      acceptTerms: true,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/reservado/);
  });

  it('con el nombre «Admin» no se queda con el identificador reservado', async () => {
    const started = new Date();
    const ids = uniqueTestIds('derived');
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Admin',
      fullName: 'Test User',
      email: ids.email,
      password: 'Secret123',
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
    const tenant = await withAdminDb((db) =>
      db.tenant.findFirst({
        where: { name: 'Admin', createdAt: { gte: started } },
        select: { id: true, slug: true },
      }),
    );
    expect(tenant).toBeTruthy();
    expect(tenant!.slug).not.toBe('admin');
    expect(tenant!.slug.startsWith('admin-')).toBe(true);
    createdIds.push(tenant!.id);
  });

  it('negocio con web publicada: el subdominio la sirve', async () => {
    const owner = await registerVerifiedUser(app, 'sub-live');
    await createFacilityWithUnits(app, owner.accessToken, { facilityName: 'Local Sub' });
    const res = await resolve(owner.slug);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      found: true,
      tenantSlug: owner.slug,
      redirectHost: null,
      serves: true,
    });
    createdIds.push(owner.tenantId);
  });

  it('sin locales (web sin publicar): el subdominio no la sirve', async () => {
    const owner = await registerVerifiedUser(app, 'sub-unpublished');
    // Los e2e dan por publicadas las webs (E2E_SKIP_READINESS): aquí se mide de verdad.
    process.env.E2E_SKIP_READINESS = 'false';
    try {
      const res = await resolve(owner.slug);
      expect(res.body).toMatchObject({ found: true, serves: false, redirectHost: null });
    } finally {
      process.env.E2E_SKIP_READINESS = 'true';
    }
    createdIds.push(owner.tenantId);
  });

  it('identificador inexistente o reservado: no encontrado', async () => {
    expect((await resolve('no-existe-subdominio-zz')).body).toMatchObject({
      found: false,
      serves: false,
    });
    expect((await resolve('api')).body).toMatchObject({ found: false, serves: false });
  });

  it('negocio con dominio propio verificado: el subdominio redirige a él', async () => {
    const owner = await registerVerifiedUser(app, 'sub-domain');
    await createFacilityWithUnits(app, owner.accessToken, { facilityName: 'Local Dom' });
    await setTenantPlan(owner.slug, 'pro');
    const domain = `sub-dominio-${Date.now().toString(36)}.example`;
    await setVerifiedCustomDomain(owner.slug, domain);
    const res = await resolve(owner.slug);
    expect(res.body).toMatchObject({ found: true, redirectHost: domain });
    createdIds.push(owner.tenantId);
  });

  it('suspendido o dado de baja: el subdominio no sirve la web', async () => {
    const owner = await registerVerifiedUser(app, 'sub-suspended');
    await createFacilityWithUnits(app, owner.accessToken, { facilityName: 'Local Susp' });
    await withAdminDb((db) =>
      db.tenant.update({ where: { slug: owner.slug }, data: { status: 'suspended' } }),
    );
    expect((await resolve(owner.slug)).body.serves).toBe(false);
    await withAdminDb((db) =>
      db.tenant.update({ where: { slug: owner.slug }, data: { status: 'cancelled' } }),
    );
    expect((await resolve(owner.slug)).body.serves).toBe(false);
    createdIds.push(owner.tenantId);
  });

  it('la cola de pendientes lista el subdominio y «Hecho» lo quita (solo superadmin)', async () => {
    const owner = await registerVerifiedUser(app, 'sub-queue');
    createdIds.push(owner.tenantId);
    const tenant = await withAdminDb((db) =>
      db.tenant.findUnique({ where: { slug: owner.slug }, select: { id: true } }),
    );

    const queue = await request(app.getHttpServer())
      .get('/admin/subdomains')
      .set({ Authorization: `Bearer ${superToken}` });
    expect(queue.status).toBe(200);
    const entry = (queue.body as { tenantId: string; host: string }[]).find(
      (e) => e.tenantId === tenant!.id,
    );
    expect(entry?.host).toBe(`${owner.slug}.localhost:3000`);

    // Soporte puede leer la cola, pero no marcar como hecho.
    const supportList = await request(app.getHttpServer())
      .get('/admin/subdomains')
      .set({ Authorization: `Bearer ${supportToken}` });
    expect(supportList.status).toBe(200);
    const denied = await request(app.getHttpServer())
      .put(`/admin/subdomains/${tenant!.id}`)
      .set({ Authorization: `Bearer ${supportToken}` })
      .send({ ready: true });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('insufficient_super_admin_role');

    const done = await request(app.getHttpServer())
      .put(`/admin/subdomains/${tenant!.id}`)
      .set({ Authorization: `Bearer ${superToken}` })
      .send({ ready: true });
    expect(done.status).toBe(200);

    const after = await request(app.getHttpServer())
      .get('/admin/subdomains')
      .set({ Authorization: `Bearer ${superToken}` });
    expect((after.body as { tenantId: string }[]).some((e) => e.tenantId === tenant!.id)).toBe(
      false,
    );
    const row = await withAdminDb((db) =>
      db.tenant.findUnique({ where: { id: tenant!.id }, select: { subdomainReadyAt: true } }),
    );
    expect(row?.subdomainReadyAt).not.toBeNull();

    const audit = await withAdminDb((db) =>
      db.superAdminAuditLog.findFirst({
        where: { targetTenantId: tenant!.id, action: 'admin.tenant.subdomain_ready_changed' },
      }),
    );
    expect(audit).toBeTruthy();
  });

  it('comprobar el subdominio: sin configurar responde «no responde» (en tests no sale a la red)', async () => {
    const owner = await registerVerifiedUser(app, 'sub-nodns');
    createdIds.push(owner.tenantId);
    const tenant = await withAdminDb((db) =>
      db.tenant.findUnique({ where: { slug: owner.slug }, select: { id: true } }),
    );
    const res = await request(app.getHttpServer())
      .get(`/admin/subdomains/${tenant!.id}/check`)
      .set({ Authorization: `Bearer ${supportToken}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, status: null });
  });

  it('sin sesión de administrador: 401', async () => {
    await request(app.getHttpServer()).get('/admin/subdomains').expect(401);
  });
});
