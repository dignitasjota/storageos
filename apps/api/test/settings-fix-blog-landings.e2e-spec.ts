import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Configuración: blog, páginas de zona y landings de promoción. */
describe('Configuración: blog, zonas y landings (e2e)', () => {
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

  it('blog: borrar una entrada la quita de las relacionadas, ignora las que ya no existen y deja rastro', async () => {
    const owner = await registerVerifiedUser(app, 'cfgblog');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const first = await http()
      .post('/blog-posts')
      .set(a)
      .send({ title: 'Primera', contentMarkdown: 'Hola' });
    expect(first.status).toBe(201);
    const second = await http()
      .post('/blog-posts')
      .set(a)
      .send({ title: 'Segunda', contentMarkdown: 'Hola', relatedPostIds: [first.body.id] });
    expect(second.body.relatedPostIds).toEqual([first.body.id]);

    await http().delete(`/blog-posts/${first.body.id}`).set(a).expect(204);
    const after = await http().get(`/blog-posts/${second.body.id}`).set(a);
    expect(after.body.relatedPostIds).toEqual([]);

    // Una relacionada que ya no existe no impide guardar.
    const saved = await http()
      .patch(`/blog-posts/${second.body.id}`)
      .set(a)
      .send({ relatedPostIds: [first.body.id], isPublished: true });
    expect(saved.status).toBe(200);
    expect(saved.body.relatedPostIds).toEqual([]);

    // Una portada que no ha llegado a subirse no se acepta.
    const ghost = await http()
      .put(`/blog-posts/${second.body.id}/cover`)
      .set(a)
      .send({ coverImageKey: `${owner.tenantId}/blog/${second.body.id}/nada.jpg` });
    expect(ghost.status).toBe(400);
    expect(ghost.body.code).toBe('file_not_uploaded');

    const admin = app.get(PrismaAdminService);
    const actions = (
      await admin.auditLog.findMany({
        where: { tenantId: owner.tenantId, entityType: 'BlogPost' },
        select: { action: true },
      })
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['blog_post.created', 'blog_post.deleted', 'blog_post.published']),
    );
  });

  it('zonas: un local borrado se quita y el texto apagado de la ciudad no cuenta como activo', async () => {
    const owner = await registerVerifiedUser(app, 'cfgzones');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await setTenantFeatureOverride(owner.slug, 'local_seo', true);

    const one = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const two = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await http().patch(`/facilities/${one.facilityId}`).set(a).send({ city: 'Mislata' });
    await http().patch(`/facilities/${two.facilityId}`).set(a).send({ city: 'Valencia' });

    const created = await http()
      .post('/settings/web/area-pages')
      .set(a)
      .send({ name: 'Paterna', facilityIds: [one.facilityId, two.facilityId] });
    expect(created.status).toBe(201);
    const page = (created.body.pages as { id: string; slug: string }[]).find(
      (p) => p.slug === 'paterna',
    )!;

    await http().delete(`/facilities/${two.facilityId}`).set(a).expect(204);
    const list = await http().get('/settings/web/area-pages').set(a);
    const saved = (list.body.pages as { id: string; facilityIds: string[] }[]).find(
      (p) => p.id === page.id,
    )!;
    expect(saved.facilityIds).toEqual([one.facilityId]);

    // Un local que ya no existe en lo enviado se ignora.
    const updated = await http()
      .patch(`/settings/web/area-pages/${page.id}`)
      .set(a)
      .send({ facilityIds: [one.facilityId, two.facilityId] });
    expect(updated.status).toBe(200);

    // Texto propio de la ciudad apagado: la ciudad sale como «texto apagado».
    await http()
      .post('/settings/web/area-pages')
      .set(a)
      .send({
        name: 'Mislata',
        intro: 'Texto propio de Mislata.',
        isPublished: false,
      })
      .expect(201);
    const overview = await http().get('/settings/web/area-pages').set(a);
    const city = (overview.body.overview as { slug: string; warnings: string[] }[]).find(
      (p) => p.slug === 'mislata',
    )!;
    expect(city.warnings).toEqual(['not_published']);
  });

  it('landings: locales y tamaños borrados, duplicar con dirección larga, cupón borrado y resultados por id', async () => {
    const owner = await registerVerifiedUser(app, 'cfgpromo');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await ensureDefaultSeries(app, owner.accessToken);
    const keep = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    const gone = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    const longSlug = 'promocion-de-verano-para-todos-los-trasteros-del-centro-xyz'; // 59
    const created = await http()
      .post('/promo-landings')
      .set(a)
      .send({
        name: 'Verano',
        slug: longSlug,
        headline: 'Verano',
        isActive: true,
        facilityIds: [keep.facilityId, gone.facilityId],
        unitTypeIds: [keep.unitTypeId, gone.unitTypeId],
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // Borrar un local lo quita de la landing (y deja guardarla).
    await http().delete(`/facilities/${gone.facilityId}`).set(a).expect(204);
    const list = await http().get('/promo-landings').set(a);
    const landing = (list.body as { id: string; facilityIds: string[] }[]).find(
      (l) => l.id === id,
    )!;
    expect(landing.facilityIds).toEqual([keep.facilityId]);
    const resaved = await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ facilityIds: [keep.facilityId, gone.facilityId], headline: 'Verano 2' });
    expect(resaved.status).toBe(200);
    expect(resaved.body.facilityIds).toEqual([keep.facilityId]);

    // Duplicar con una dirección larga: siempre cabe y no se repite.
    const copy1 = await http().post(`/promo-landings/${id}/duplicate`).set(a);
    const copy2 = await http().post(`/promo-landings/${id}/duplicate`).set(a);
    expect(copy1.status).toBe(201);
    expect(copy2.status).toBe(201);
    expect(copy1.body.slug.length).toBeLessThanOrEqual(60);
    expect(copy2.body.slug.length).toBeLessThanOrEqual(60);
    expect(copy1.body.slug).not.toBe(copy2.body.slug);

    // Foto que no ha llegado a subirse.
    const ghost = await http()
      .put(`/promo-landings/${id}/image`)
      .set(a)
      .send({ heroImageKey: `${owner.tenantId}/promo/${id}/nada.jpg` });
    expect(ghost.status).toBe(400);
    expect(ghost.body.code).toBe('file_not_uploaded');

    // Cupón borrado: la landing deja de anunciar la oferta.
    const coupon = await http().post('/coupons').set(a).send({
      code: 'BORRAR',
      name: 'Borrar',
      discountType: 'percentage',
      discountValue: 10,
    });
    await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({
        couponId: coupon.body.id,
        content: { offer: { enabled: true, title: '10 %' }, promotion: { enabled: true } },
      })
      .expect(200);
    await http().delete(`/coupons/${coupon.body.id}`).set(a).expect(204);
    const pub = await http().get(`/public/landing/${owner.slug}/promo/${longSlug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.promo.id).toBe(id);
    expect(pub.body.promo.coupon).toBeNull();
    expect(pub.body.promo.content.offer.enabled).toBe(false);
    expect(pub.body.promo.content.promotion.enabled).toBe(false);

    // Reserva desde la landing con su id (utm_content): cuenta aunque cambie la dirección.
    const email = `cfg-promo-${Date.now()}@e2e.local`;
    const booked = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: keep.facilityId,
        unitTypeId: keep.unitTypeId,
        startDate: '2026-03-15',
        months: 1,
        utmSource: 'flyer',
        utmMedium: 'offline',
        utmCampaign: `promo-${longSlug}`,
        utmContent: id,
        customer: {
          firstName: 'Ana',
          lastName: 'Ruiz',
          email,
          phone: '600111222',
          documentNumber: '12345678Z',
        },
      });
    expect(booked.status).toBe(201);
    await http()
      .post(`/public/move-in/sign/${booked.body.signingToken}`)
      .send({
        immediateStart: true,
        signerName: 'Ana Ruiz',
        method: 'typed',
        typedSignature: 'Ana Ruiz',
        accept: true,
        generalTermsHash: await generalTermsHash(app, booked.body.signingToken),
      })
      .expect(201);

    await http().patch(`/promo-landings/${id}`).set(a).send({ slug: 'verano-nuevo' }).expect(200);
    const stats = await http().get(`/promo-landings/${id}/stats?days=0`).set(a);
    expect(stats.status).toBe(200);
    expect(stats.body.bookings).toBe(1);

    // Otra landing que reutiliza la dirección antigua no hereda la reserva.
    const reuse = await http()
      .post('/promo-landings')
      .set(a)
      .send({ name: 'Otra', slug: longSlug, headline: 'Otra' });
    expect(reuse.status).toBe(201);
    const reuseStats = await http().get(`/promo-landings/${reuse.body.id}/stats?days=0`).set(a);
    expect(reuseStats.body.bookings).toBe(0);

    // Borrar el tamaño que quedaba solo apaga la landing (vacío sería «todos»).
    const admin = app.get(PrismaAdminService);
    const lonely = await http()
      .post('/unit-types')
      .set(a)
      .send({ name: `Sin trasteros ${Date.now()}`, defaultPriceMonthly: 30, color: '#3366ff' });
    expect(lonely.status).toBe(201);
    await admin.promoLanding.update({
      where: { id },
      data: { unitTypeIds: [lonely.body.id], isActive: true },
    });
    await http().delete(`/unit-types/${lonely.body.id}`).set(a).expect(204);
    const off = await admin.promoLanding.findUniqueOrThrow({ where: { id } });
    expect(off.unitTypeIds).toEqual([]);
    expect(off.isActive).toBe(false);

    const actions = (
      await admin.auditLog.findMany({
        where: { tenantId: owner.tenantId, entityType: 'PromoLanding' },
        select: { action: true },
      })
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'promo_landing.created',
        'promo_landing.duplicated',
        'promo_landing.slug_changed',
      ]),
    );
  });
});
