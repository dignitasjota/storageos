import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Landing pública por tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve tenant + facilities con disponibilidad y precio (sin auth)', async () => {
    const owner = await registerVerifiedUser(app, 'landing-ok');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Centro',
      unitsCount: 3,
      pricePerUnit: 65,
    });

    const res = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantSlug).toBe(owner.slug);
    expect(Array.isArray(res.body.facilities)).toBe(true);
    const fac = res.body.facilities.find((f: { name: string }) => f.name === 'Local Centro');
    expect(fac).toBeTruthy();
    expect(fac.unitTypes.length).toBeGreaterThanOrEqual(1);
    expect(fac.unitTypes[0].available).toBeGreaterThan(0);
    expect(fac.unitTypes[0].priceMonthly).toBe(65);
  });

  it('slug desconocido devuelve 404', async () => {
    const res = await request(app.getHttpServer()).get('/public/landing/no-existe-xyz');
    expect(res.status).toBe(404);
  });

  it('white-label: la landing devuelve el color y logo de marca del operador', async () => {
    const owner = await registerVerifiedUser(app, 'landing-brand');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Marca',
      unitsCount: 1,
      pricePerUnit: 40,
    });
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin branding configurado → null.
    const before = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(before.body.brandColor).toBeNull();
    expect(before.body.logoUrl).toBeNull();

    // Configura marca (reutiliza el white-label del portal).
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ portalBrandColor: '#ff6600', portalLogoUrl: 'https://cdn.example.com/logo.png' })
      .expect(200);

    const after = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(after.body.brandColor).toBe('#ff6600');
    expect(after.body.logoUrl).toBe('https://cdn.example.com/logo.png');

    // También en la página por local.
    const fac = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}/local-marca`);
    expect(fac.body.brandColor).toBe('#ff6600');
    expect(fac.body.logoUrl).toBe('https://cdn.example.com/logo.png');
  });

  it('página por local: GET /public/landing/:slug/:facilitySlug devuelve el local', async () => {
    const owner = await registerVerifiedUser(app, 'landing-fac');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Norte',
      unitsCount: 2,
      pricePerUnit: 50,
    });

    // El publicSlug se autogenera del nombre: "Local Norte" → "local-norte".
    const res = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}/local-norte`);
    expect(res.status).toBe(200);
    expect(res.body.facility.name).toBe('Local Norte');
    expect(res.body.facility.publicSlug).toBe('local-norte');
    expect(res.body.facility.unitTypes.length).toBeGreaterThanOrEqual(1);

    const missing = await request(app.getHttpServer()).get(
      `/public/landing/${owner.slug}/no-existe`,
    );
    expect(missing.status).toBe(404);
  });

  it('sitemap: incluye el tenant y los slugs de sus locales', async () => {
    const owner = await registerVerifiedUser(app, 'landing-sitemap');
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Sur',
      unitsCount: 1,
    });

    const res = await request(app.getHttpServer()).get('/public/landing/sitemap');
    expect(res.status).toBe(200);
    const entry = (res.body.entries as { tenantSlug: string; facilitySlugs: string[] }[]).find(
      (e) => e.tenantSlug === owner.slug,
    );
    expect(entry).toBeTruthy();
    expect(entry!.facilitySlugs).toContain('local-sur');
  });

  it('web premium: sin la feature, el settings da 403 y la landing usa default', async () => {
    const owner = await registerVerifiedUser(app, 'web-off');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    // El endpoint de ajustes está gateado por la feature → 403 sin ella.
    await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set(auth)
      .send({ template: 'modern', headline: 'Mi web' })
      .expect(403);

    // La landing pública siempre responde, con plantilla por defecto y sin textos.
    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.status).toBe(200);
    expect(landing.body.webTemplate).toBe('default');
    expect(landing.body.webHeadline).toBeNull();
    expect(landing.body.webAbout).toBeNull();
  });

  it('web premium: con la feature, se guarda y la landing aplica plantilla + textos', async () => {
    const owner = await registerVerifiedUser(app, 'web-on');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    // Guardar plantilla + textos.
    const save = await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set(auth)
      .send({ template: 'modern', headline: 'Guarda con seguridad', about: 'Somos el mejor.' });
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({
      template: 'modern',
      headline: 'Guarda con seguridad',
      about: 'Somos el mejor.',
    });

    // La landing pública refleja la plantilla y los textos.
    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.body.webTemplate).toBe('modern');
    expect(landing.body.webHeadline).toBe('Guarda con seguridad');
    expect(landing.body.webAbout).toBe('Somos el mejor.');

    // Vaciar el about ('' = borrar) lo pone a null.
    await request(app.getHttpServer())
      .patch('/settings/tenant/web')
      .set(auth)
      .send({ about: '' })
      .expect(200);
    const after = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(after.body.webAbout).toBeNull();
    expect(after.body.webTemplate).toBe('modern'); // se conserva
  });
});
