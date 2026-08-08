import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setTenantPlan,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-external-site-test@storageos.local';

/**
 * Web «externa» del tenant (proxy inverso hacia una URL que ya aloja fuera de
 * la plataforma; nunca almacenamos su contenido). Requiere `web_premium`
 * (add-on, fuera de plan) + dominio propio VERIFICADO (`custom_domain`,
 * feature de `pro`). Valida formato + IP no privada (SSRF) al guardar.
 */
describe('Web externa del tenant (e2e)', () => {
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
        fullName: 'Admin External Site Test',
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

  /** Sube el tenant a `pro` + `web_premium` (add-on) + fija y verifica un dominio propio. */
  async function setupTenantWithVerifiedDomain(
    prefix: string,
  ): Promise<{ owner: Awaited<ReturnType<typeof registerVerifiedUser>>; domain: string }> {
    const owner = await registerVerifiedUser(app, prefix);
    await setTenantPlan(owner.slug, 'pro');
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    const domain = `${prefix}-${Date.now().toString(36)}.example`;
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ customDomain: domain })
      .expect(200);
    const tenantRow = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantRow!.id}/custom-domain/verify`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);
    return { owner, domain };
  }

  it('sin dominio propio verificado → 400 custom_domain_required', async () => {
    const owner = await registerVerifiedUser(app, 'ext-nodomain');
    await setTenantPlan(owner.slug, 'pro');
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const res = await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ template: 'external', externalSiteUrl: 'https://93.184.216.34/' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('custom_domain_required');
  });

  it('URL http:// (no https) → 400 external_site_url_invalid', async () => {
    const { owner } = await setupTenantWithVerifiedDomain('ext-http');
    const res = await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ template: 'external', externalSiteUrl: 'http://example.com/' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('external_site_url_invalid');
  });

  it('IP privada/loopback (SSRF) → 400 external_site_url_invalid', async () => {
    const { owner } = await setupTenantWithVerifiedDomain('ext-ssrf');
    for (const bad of ['https://127.0.0.1/', 'https://10.0.0.5/', 'https://[::1]/']) {
      const res = await request(app.getHttpServer())
        .patch('/settings/tenant/web')
        .set({ Authorization: `Bearer ${owner.accessToken}` })
        .send({ template: 'external', externalSiteUrl: bad });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('external_site_url_invalid');
    }
  });

  it('template=external sin URL (ni en el PATCH ni ya guardada) → 400 external_site_url_required', async () => {
    const { owner } = await setupTenantWithVerifiedDomain('ext-nourl');
    const res = await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ template: 'external' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('external_site_url_required');
  });

  it('URL pública válida: guarda, la expone en GET web, en /external-site y en resolve-domain', async () => {
    const { owner, domain } = await setupTenantWithVerifiedDomain('ext-ok');
    const url = 'https://93.184.216.34/';

    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ template: 'external', externalSiteUrl: url });
    expect(patch.status).toBe(200);
    expect(patch.body.template).toBe('external');
    expect(patch.body.externalSiteUrl).toBe(url);

    // GET /settings/tenant/web refleja lo guardado.
    const get = await request(app.getHttpServer())
      .get('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(get.status).toBe(200);
    expect(get.body.template).toBe('external');
    expect(get.body.externalSiteUrl).toBe(url);

    // Endpoint público ligero que consume la ruta de proxy del web.
    const site = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/external-site`,
    );
    expect(site.status).toBe(200);
    expect(site.body.baseUrl).toBe(url);

    // resolve-domain (lo usa el middleware) marca hasExternalSite.
    const resolved = await request(app.getHttpServer())
      .get('/public/landing/resolve-domain')
      .query({ host: domain });
    expect(resolved.status).toBe(200);
    expect(resolved.body.tenantSlug).toBe(owner.slug);
    expect(resolved.body.hasExternalSite).toBe(true);

    // La landing pública también refleja la plantilla `external` + el dominio.
    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.body.webTemplate).toBe('external');
    expect(landing.body.customDomain).toBe(domain);
  });

  it('volver a una plantilla propia deja de exponer la web externa como activa', async () => {
    const { owner } = await setupTenantWithVerifiedDomain('ext-revert');
    await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ template: 'external', externalSiteUrl: 'https://93.184.216.34/' })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ template: 'onepage' })
      .expect(200);

    const site = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/external-site`,
    );
    expect(site.status).toBe(404);

    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.body.webTemplate).toBe('onepage');
  });

  it('si el dominio propio se desverifica, la landing cae a la plantilla default (nunca una web rota)', async () => {
    const { owner } = await setupTenantWithVerifiedDomain('ext-unverify');
    await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ template: 'external', externalSiteUrl: 'https://93.184.216.34/' })
      .expect(200);

    const tenantRow = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantRow!.id}/custom-domain/revoke`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);

    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.body.webTemplate).toBe('default');
  });

  it('sin auth → 401', async () => {
    await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .send({ template: 'external', externalSiteUrl: 'https://93.184.216.34/' })
      .expect(401);
  });
});
