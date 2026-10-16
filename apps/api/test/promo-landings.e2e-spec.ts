import request from 'supertest';

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
});
