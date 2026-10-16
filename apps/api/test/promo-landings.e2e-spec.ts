import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Landings de promoción (e2e)', () => {
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

  it('crear, publicar, cupón y fechas; apagada o caducada no se sirve', async () => {
    const owner = await registerVerifiedUser(app, 'promo-land');
    const a = auth(owner.accessToken);

    // Sin Web Premium no hay landings.
    expect((await http().get('/promo-landings').set(a)).status).toBe(403);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);

    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    const coupon = await http().post('/coupons').set(a).send({
      code: 'VERANO',
      name: 'Verano',
      discountType: 'free_months',
      discountValue: 1,
      minMonths: 3,
    });

    const created = await http()
      .post('/promo-landings')
      .set(a)
      .send({
        name: 'Verano',
        slug: 'verano',
        headline: 'Un mes gratis este verano',
        offerText: '1 mes gratis',
        benefits: ['Sin permanencia', 'Acceso con el móvil'],
        conditions: 'Pagando 3 meses por adelantado.',
        couponId: coupon.body.id,
        facilityIds: [fac.facilityId],
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: 'verano',
      isActive: false,
      live: false,
      couponCode: 'VERANO',
    });
    const id = created.body.id as string;

    // Apagada: la web pública no la sirve.
    expect((await http().get(`/public/landing/${owner.slug}/promo/verano`)).status).toBe(404);

    await http().patch(`/promo-landings/${id}`).set(a).send({ isActive: true }).expect(200);
    const pub = await http().get(`/public/landing/${owner.slug}/promo/verano`);
    expect(pub.status).toBe(200);
    expect(pub.body.promo).toMatchObject({
      headline: 'Un mes gratis este verano',
      benefits: ['Sin permanencia', 'Acceso con el móvil'],
      coupon: { code: 'VERANO', minMonths: 3, summary: '1 mes gratis desde 3 meses' },
      facilityIds: [fac.facilityId],
    });
    expect(pub.body.site.tenantSlug).toBe(owner.slug);
    expect(pub.body.site.facilities[0].unitTypes.length).toBeGreaterThan(0);

    // Editar un texto no borra el resto.
    const edited = await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ subheadline: 'Solo julio' });
    expect(edited.body).toMatchObject({
      subheadline: 'Solo julio',
      conditions: 'Pagando 3 meses por adelantado.',
    });

    // Caducada: tampoco.
    await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ startsAt: '2025-01-01T00:00:00.000Z', endsAt: '2025-02-01T00:00:00.000Z' })
      .expect(200);
    expect((await http().get(`/public/landing/${owner.slug}/promo/verano`)).status).toBe(404);

    // Dirección repetida, fechas al revés y cupón ajeno.
    const dup = await http()
      .post('/promo-landings')
      .set(a)
      .send({ name: 'Otra', slug: 'verano', headline: 'x' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('promo_slug_taken');
    const badDates = await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-07-01T00:00:00.000Z' });
    expect(badDates.status).toBe(400);
    const badCoupon = await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ couponId: '00000000-0000-4000-8000-000000000000' });
    expect(badCoupon.status).toBe(400);
    expect(badCoupon.body.code).toBe('invalid_reference');

    // Duplicar para la siguiente promoción: apagada y con otra dirección.
    const copy = await http().post(`/promo-landings/${id}/duplicate`).set(a);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({
      slug: 'verano-copia',
      isActive: false,
      headline: 'Un mes gratis este verano',
    });

    await http().delete(`/promo-landings/${copy.body.id}`).set(a).expect(204);
    expect((await http().get('/promo-landings').set(a)).body).toHaveLength(1);
  });

  it('una landing sin cupón y sin Web Premium no se sirve', async () => {
    const owner = await registerVerifiedUser(app, 'promo-nocoupon');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await http()
      .post('/promo-landings')
      .set(a)
      .send({
        name: 'Local nuevo',
        slug: 'local-nuevo',
        headline: 'Abrimos en Mislata',
        isActive: true,
      })
      .expect(201);
    const pub = await http().get(`/public/landing/${owner.slug}/promo/local-nuevo`);
    expect(pub.status).toBe(200);
    expect(pub.body.promo.coupon).toBeNull();

    await setTenantFeatureOverride(owner.slug, 'web_premium', false);
    expect((await http().get(`/public/landing/${owner.slug}/promo/local-nuevo`)).status).toBe(404);
  });

  it('enlaces por origen, enlace corto a la landing y visitas', async () => {
    const owner = await registerVerifiedUser(app, 'promo-track');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    const landing = await http()
      .post('/promo-landings')
      .set(a)
      .send({ name: 'Otoño', slug: 'otono', headline: 'Otoño', isActive: true });
    const landingId = landing.body.id as string;

    const channel = await http()
      .post('/marketing/channels')
      .set(a)
      .send({ name: 'Flyer buzoneo', type: 'physical', promoLandingId: landingId });
    expect(channel.status).toBe(201);
    expect(channel.body.promoLandingId).toBe(landingId);
    const url = new URL(channel.body.landingUrl as string);
    expect(url.pathname).toBe(`/s/${owner.slug}/promo/otono`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      utm_source: 'flyer_buzoneo',
      utm_medium: 'offline',
      utm_campaign: 'promo-otono',
    });

    // El enlace corto / QR lleva a la landing (no a la reserva) y cuenta el clic.
    const go = await http().get(`/public/marketing/go/${channel.body.shortCode}`);
    expect(go.body.targetUrl).toBe(channel.body.landingUrl);

    // Visitas: una por visitante cada 30 min; apagada no cuenta.
    const visit = (visitorId: string) =>
      http()
        .post(`/public/landing/${owner.slug}/promo/otono/visit`)
        .send({ visitorId, source: 'Flyer_Buzoneo', medium: 'offline', campaign: 'promo-otono' });
    await visit('visitor-aaaa-1').expect(204);
    await visit('visitor-aaaa-1').expect(204);
    await visit('visitor-bbbb-2').expect(204);
    const admin = app.get(PrismaAdminService);
    const rows = await admin.promoLandingVisit.findMany({ where: { promoLandingId: landingId } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.source).toBe('flyer_buzoneo');
    await http().patch(`/promo-landings/${landingId}`).set(a).send({ isActive: false }).expect(200);
    await visit('visitor-cccc-3').expect(204);
    expect(await admin.promoLandingVisit.count({ where: { promoLandingId: landingId } })).toBe(2);

    // Una landing de otro negocio no se puede enlazar.
    const other = await registerVerifiedUser(app, 'promo-track-b');
    const bad = await http()
      .post('/marketing/channels')
      .set(auth(other.accessToken))
      .send({ name: 'Ajena', type: 'other', promoLandingId: landingId });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('promo_landing_not_found');
  });
});
