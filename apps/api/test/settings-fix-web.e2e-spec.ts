import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import {
  cleanupTestTenants,
  setTenantFeatureOverride,
  setTenantPlan,
  setVerifiedCustomDomain,
  withAdminDb,
} from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

/**
 * Revisión de Configuración → web pública y marca: web externa sin bucles,
 * dominio propio (plataforma, reservas sin verificar, plan), subidas que
 * existen de verdad y se borran al cambiarlas, y widget con el precio de la web.
 */
describe('Configuración de la web y la marca (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  async function upload(
    auth: Record<string, string>,
    path: string,
    payload: Record<string, unknown>,
    body: Buffer,
  ): Promise<string> {
    const presign = await http().post(path).set(auth).send(payload);
    expect(presign.status).toBe(200);
    const put = await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body,
    });
    expect(put.status).toBe(200);
    return presign.body.key as string;
  }

  it('web externa: no puede apuntar al propio dominio (con o sin www) ni a la plataforma', async () => {
    const owner = await registerVerifiedUser(app, 'sfw-ext');
    await setTenantPlan(owner.slug, 'pro');
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    const domain = `sfw-${Date.now().toString(36)}.example`;
    await setVerifiedCustomDomain(owner.slug, domain);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    for (const url of [`https://${domain}/`, `https://www.${domain}/inicio`]) {
      const res = await http()
        .patch('/settings/tenant/web')
        .set(auth)
        .send({ template: 'external', externalSiteUrl: url });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('external_site_url_invalid');
      expect(res.body.details.reason).toBe('own_domain');
    }

    // Un subdominio de la plataforma tampoco.
    const platform = await http()
      .patch('/settings/tenant/web')
      .set(auth)
      .send({ template: 'external', externalSiteUrl: 'https://app.localhost/' });
    expect(platform.status).toBe(400);
    expect(platform.body.details.reason).toBe('platform_host');
  });

  it('dominio propio: rechaza los de la plataforma y deja de servirse sin la función', async () => {
    const owner = await registerVerifiedUser(app, 'sfw-dom');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const bad = await http()
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ customDomain: 'app.localhost' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('domain_not_allowed');

    const domain = `sfw-plan-${Date.now().toString(36)}.example`;
    await setVerifiedCustomDomain(owner.slug, domain);
    await http().get('/public/landing/resolve-domain').query({ host: domain }).expect(200);

    // Baja de plan: la web ya no se sirve en ese dominio.
    await setTenantPlan(owner.slug, 'starter');
    await http().get('/public/landing/resolve-domain').query({ host: domain }).expect(404);

    // Y se puede quitar aunque el plan ya no lo incluya.
    const removed = await http()
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ customDomain: '' });
    expect(removed.status).toBe(200);
    expect(removed.body.customDomain).toBeNull();
  });

  it('dominio sin verificar de otra cuenta: espera 7 días y después se libera', async () => {
    const a = await registerVerifiedUser(app, 'sfw-hold-a');
    const b = await registerVerifiedUser(app, 'sfw-hold-b');
    await setTenantPlan(a.slug, 'pro');
    await setTenantPlan(b.slug, 'pro');
    const domain = `sfw-hold-${Date.now().toString(36)}.example`;

    await http()
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${a.accessToken}` })
      .send({ customDomain: domain })
      .expect(200);

    const early = await http()
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${b.accessToken}` })
      .send({ customDomain: domain });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('domain_pending_elsewhere');

    // Pasan 8 días sin que A lo verifique.
    await withAdminDb(async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: a.slug } });
      await db.auditLog.updateMany({
        where: { tenantId: tenant.id, action: 'tenant.branding.settings_changed' },
        data: { occurredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
      });
    });

    const claimed = await http()
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${b.accessToken}` })
      .send({ customDomain: domain });
    expect(claimed.status).toBe(200);
    expect(claimed.body.customDomain).toBe(domain);
    const aNow = await withAdminDb((db) => db.tenant.findUnique({ where: { slug: a.slug } }));
    expect(aNow?.customDomain).toBeNull();

    // Uno ya verificado no se libera nunca.
    const c = await registerVerifiedUser(app, 'sfw-hold-c');
    await setTenantPlan(c.slug, 'pro');
    await setVerifiedCustomDomain(b.slug, domain);
    const verified = await http()
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${c.accessToken}` })
      .send({ customDomain: domain });
    expect(verified.status).toBe(409);
    expect(verified.body.code).toBe('domain_taken');
  });

  it('logo, favicon y fotos de portada: el fichero tiene que existir', async () => {
    const owner = await registerVerifiedUser(app, 'sfw-up');
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await withAdminDb((db) => db.tenant.findUnique({ where: { slug: owner.slug } }));
    const id = tenant!.id;

    // Claves con el prefijo correcto pero sin subir nada.
    const logo = await http()
      .put('/settings/tenant/branding/logo')
      .set(auth)
      .send({ key: `${id}/logo/no-existe.png` });
    expect(logo.status).toBe(400);
    const favicon = await http()
      .put('/settings/tenant/branding/favicon')
      .set(auth)
      .send({ key: `${id}/favicon/no-existe.png` });
    expect(favicon.status).toBe(400);
    const hero = await http()
      .put('/settings/tenant/web/hero-image')
      .set(auth)
      .send({ slot: 'image', key: `${id}/web-hero/image-no-existe.png` });
    expect(hero.status).toBe(400);
  });

  it('cambiar el logo o el favicon borra el anterior del almacenamiento', async () => {
    const owner = await registerVerifiedUser(app, 'sfw-del');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const first = await upload(
      auth,
      '/settings/tenant/branding/logo-upload-url',
      { mimeType: 'image/png' },
      PNG,
    );
    const set1 = await http().put('/settings/tenant/branding/logo').set(auth).send({ key: first });
    expect(set1.status).toBe(200);
    const firstUrl = set1.body.portalLogoUrl as string;
    expect((await fetch(firstUrl)).status).toBe(200);

    const second = await upload(
      auth,
      '/settings/tenant/branding/logo-upload-url',
      { mimeType: 'image/png' },
      PNG,
    );
    await http().put('/settings/tenant/branding/logo').set(auth).send({ key: second }).expect(200);
    expect((await fetch(firstUrl)).status).toBe(404);

    // Un enlace pegado sustituye al subido y también lo borra.
    const set2 = await http().get('/settings/tenant/branding').set(auth);
    const secondUrl = set2.body.portalLogoUrl as string;
    await http()
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ portalLogoUrl: 'https://93.184.216.34/logo.png' })
      .expect(200);
    expect((await fetch(secondUrl)).status).toBe(404);

    const fav1 = await upload(
      auth,
      '/settings/tenant/branding/favicon-upload-url',
      { mimeType: 'image/png' },
      PNG,
    );
    const f1 = await http().put('/settings/tenant/branding/favicon').set(auth).send({ key: fav1 });
    const fav1Url = f1.body.faviconUrl as string;
    await http().put('/settings/tenant/branding/favicon').set(auth).send({ key: null }).expect(200);
    expect((await fetch(fav1Url)).status).toBe(404);
  });

  it('widget: precio del trastero más barato disponible con su IVA y sin tamaños ajenos', async () => {
    const owner = await registerVerifiedUser(app, 'sfw-widget');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId, unitIds } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 2, pricePerUnit: 50 },
    );
    // Otro tamaño sin trasteros en este local: no debe salir.
    await http()
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Sin trasteros', defaultPriceMonthly: 10, color: '#000000' })
      .expect(201);
    await withAdminDb(async (db) => {
      await db.unit.update({ where: { id: unitIds[0]! }, data: { basePriceMonthly: 45 } });
      // El más barato está alquilado: no cuenta.
      await db.unit.update({
        where: { id: unitIds[1]! },
        data: { basePriceMonthly: 30, status: 'occupied' },
      });
    });

    const res = await http().get(`/public/widget/${owner.slug}/facilities`);
    expect(res.status).toBe(200);
    const facility = (res.body as { id: string; unitTypes: Record<string, unknown>[] }[]).find(
      (f) => f.id === facilityId,
    );
    expect(facility?.unitTypes).toHaveLength(1);
    expect(facility?.unitTypes[0]).toMatchObject({
      id: unitTypeId,
      defaultPriceMonthly: 45,
      taxRate: 21,
      availableUnits: 1,
    });

    // Suspendido: el widget no se sirve.
    await withAdminDb((db) =>
      db.tenant.update({ where: { slug: owner.slug }, data: { status: 'suspended' } }),
    );
    await http().get(`/public/widget/${owner.slug}/facilities`).expect(404);
    await http()
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Ana',
        email: 'ana@example.com',
        phone: '+34 600 111 222',
        hp: '',
        acceptsTerms: true,
      })
      .expect(404);
  });
});
