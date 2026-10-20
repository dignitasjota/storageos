import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Páginas de zona (`/trasteros-en-<zona>`): texto propio de cada ciudad, zonas
 * cercanas sin local y qué se ofrece a Google (sitemap) y qué lleva a otra página.
 */
describe('Páginas de zona de la web (e2e)', () => {
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
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const words = (n: number) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ');

  async function facility(token: string, name: string, city: string) {
    const f = await createFacilityWithUnits(app, token, { facilityName: name, unitsCount: 1 });
    const res = await http().patch(`/facilities/${f.facilityId}`).set(auth(token)).send({ city });
    expect(res.status).toBe(200);
    return { id: f.facilityId, publicSlug: res.body.publicSlug as string };
  }

  it('ciudades, zonas cercanas, la ficha que hace de ciudad y el sitemap', async () => {
    const owner = await registerVerifiedUser(app, 'areapages');
    const a = auth(owner.accessToken);
    expect((await http().get('/settings/web/area-pages').set(a)).status).toBe(403);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const madrid1 = await facility(owner.accessToken, 'Centro Norte', 'Madrid');
    await facility(owner.accessToken, 'Centro Sur', 'Madrid');
    const mislata = await facility(owner.accessToken, 'Centro Mislata', 'Mislata');

    const first = await http().get('/settings/web/area-pages').set(a);
    expect(first.status).toBe(200);
    expect(first.body.singleFacility).toBe(false);
    const madrid = first.body.overview.find((p: { slug: string }) => p.slug === 'madrid');
    expect(madrid).toMatchObject({ kind: 'city', indexable: true, warnings: ['no_intro'] });
    expect(first.body.overview.find((p: { slug: string }) => p.slug === 'mislata')).toMatchObject({
      kind: 'city',
      redirect: { to: 'facility', publicSlug: mislata.publicSlug },
    });

    // Texto propio de Mislata (ciudad): los locales que se envíen no se guardan.
    const city = await http()
      .post('/settings/web/area-pages')
      .set(a)
      .send({
        name: 'Mislata',
        intro: 'A dos paradas de metro de Valencia.',
        nearbyAreas: ['Xirivella', 'Quart de Poblet'],
        faqs: [{ question: '¿Se puede entrar con furgoneta?', answer: 'Sí, hasta la puerta.' }],
        facilityIds: [madrid1.id],
      });
    expect(city.status).toBe(201);
    expect(city.body.pages[0]).toMatchObject({ slug: 'mislata', facilityIds: [] });

    // Zona cercana sin locales → 400; con local y poco texto: en la web, no en Google.
    const noFac = await http().post('/settings/web/area-pages').set(a).send({ name: 'Paterna' });
    expect(noFac.status).toBe(400);
    expect(noFac.body.code).toBe('area_page_facilities_required');
    const near = await http()
      .post('/settings/web/area-pages')
      .set(a)
      .send({
        name: 'Paterna',
        facilityIds: [mislata.id],
        nearestNote: 'Nuestro local más cercano está en Mislata, a 8 km.',
        intro: 'Poco texto.',
      });
    expect(near.status).toBe(201);
    const paterna = near.body.overview.find((p: { slug: string }) => p.slug === 'paterna');
    expect(paterna).toMatchObject({ kind: 'nearby', indexable: false, warnings: ['short_intro'] });
    const dup = await http()
      .post('/settings/web/area-pages')
      .set(a)
      .send({ name: 'Paterna', facilityIds: [mislata.id] });
    expect(dup.status).toBe(409);

    // La web pública lleva el texto; la ficha de Mislata hace de página de la ciudad.
    const landing = await http().get(`/public/landing/${owner.slug}`);
    expect(landing.body.areaPages.map((p: { slug: string }) => p.slug).sort()).toEqual([
      'mislata',
      'paterna',
    ]);
    const ficha = await http().get(`/public/landing/${owner.slug}/${mislata.publicSlug}`);
    expect(ficha.body).toMatchObject({
      cityPage: null,
      singleFacility: false,
      areaPage: {
        slug: 'mislata',
        content: {
          intro: 'A dos paradas de metro de Valencia.',
          nearbyAreas: ['Xirivella', 'Quart de Poblet'],
        },
      },
    });
    const norte = await http().get(`/public/landing/${owner.slug}/${madrid1.publicSlug}`);
    expect(norte.body).toMatchObject({ cityPage: { slug: 'madrid' }, areaPage: null });

    const entry = async () =>
      (await http().get('/public/landing/sitemap')).body.entries.find(
        (e: { tenantSlug: string }) => e.tenantSlug === owner.slug,
      );
    expect((await entry()).citySlugs).toEqual(['madrid']);

    // Con texto suficiente la zona cercana va a Google.
    const pid = near.body.pages.find((p: { slug: string }) => p.slug === 'paterna').id;
    await http()
      .patch(`/settings/web/area-pages/${pid}`)
      .set(a)
      .send({ intro: words(130) })
      .expect(200);
    expect((await entry()).citySlugs).toEqual(['madrid', 'paterna']);

    // Apagada: deja de existir en la web.
    await http()
      .patch(`/settings/web/area-pages/${pid}`)
      .set(a)
      .send({ isPublished: false })
      .expect(200);
    expect((await entry()).citySlugs).toEqual(['madrid']);
    const del = await http().delete(`/settings/web/area-pages/${pid}`).set(a);
    expect(del.status).toBe(200);
    expect(del.body.pages).toHaveLength(1);
  });

  it('con un solo local la ficha apunta a la portada y no va al sitemap', async () => {
    const owner = await registerVerifiedUser(app, 'areasingle');
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    const only = await facility(owner.accessToken, 'Único', 'Mislata');
    const ficha = await http().get(`/public/landing/${owner.slug}/${only.publicSlug}`);
    expect(ficha.body).toMatchObject({ singleFacility: true, cityPage: null, areaPage: null });
    const entry = (await http().get('/public/landing/sitemap')).body.entries.find(
      (e: { tenantSlug: string }) => e.tenantSlug === owner.slug,
    );
    expect(entry).toMatchObject({ facilitySlugs: [], citySlugs: [] });
    const settings = await http().get('/settings/web/area-pages').set(auth(owner.accessToken));
    expect(settings.body.singleFacility).toBe(true);
    expect(settings.body.overview[0]).toMatchObject({ slug: 'mislata', redirect: { to: 'home' } });
  });
});
