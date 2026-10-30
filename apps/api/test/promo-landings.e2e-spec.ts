import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
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
        content: {
          offer: { enabled: true, title: '1 mes gratis' },
          benefits: {
            enabled: true,
            items: [{ title: 'Sin permanencia' }, { title: 'Acceso con el móvil' }],
          },
          conditions: { enabled: true, items: ['Pagando 3 meses por adelantado.'] },
        },
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
      preview: false,
      coupon: { code: 'VERANO', minMonths: 3, summary: '1 mes gratis desde 3 meses' },
      facilityIds: [fac.facilityId],
    });
    expect(pub.body.promo.content.benefits.items.map((b: { title: string }) => b.title)).toEqual([
      'Sin permanencia',
      'Acceso con el móvil',
    ]);
    // Lo no enviado sale con los valores por defecto (bloques y botones).
    expect(pub.body.promo.content.hero.primaryCta).toEqual({
      label: 'Reservar ahora',
      action: 'book',
    });
    expect(pub.body.site.tenantSlug).toBe(owner.slug);
    expect(pub.body.site.facilities[0].unitTypes.length).toBeGreaterThan(0);

    expect(pub.body.promo.content.offer.enabled).toBe(true);

    // Con el cupón apagado no se anuncia la oferta.
    await http().patch(`/coupons/${coupon.body.id}`).set(a).send({ isActive: false }).expect(200);
    const off = await http().get(`/public/landing/${owner.slug}/promo/verano`);
    expect(off.body.promo.coupon).toBeNull();
    expect(off.body.promo.content.offer.enabled).toBe(false);
    await http().patch(`/coupons/${coupon.body.id}`).set(a).send({ isActive: true }).expect(200);

    // Editar un texto no borra el resto.
    const edited = await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ subheadline: 'Solo julio' });
    expect(edited.body.subheadline).toBe('Solo julio');
    expect(edited.body.content.conditions.items).toEqual(['Pagando 3 meses por adelantado.']);

    // Un botón con una acción que no existe (p. ej. una dirección) se rechaza.
    const badCta = await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ content: { hero: { primaryCta: { label: 'Ir', action: 'https://evil.test' } } } });
    expect(badCta.status).toBe(400);

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

  it('resultados: visitas por origen, reservas, pagadas e ingresos', async () => {
    const owner = await registerVerifiedUser(app, 'promo-stats');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    const coupon = await http().post('/coupons').set(a).send({
      code: 'DIEZ',
      name: 'Diez',
      discountType: 'percentage',
      discountValue: 10,
    });
    await http()
      .post('/promo-landings')
      .set(a)
      .send({
        name: 'Inv',
        slug: 'invierno',
        headline: 'Invierno',
        isActive: true,
        couponId: coupon.body.id,
      })
      .expect(201);
    const list = await http().get('/promo-landings').set(a);
    const id = (list.body as { id: string }[])[0]!.id;

    const visit = (visitorId: string, source: string) =>
      http()
        .post(`/public/landing/${owner.slug}/promo/invierno/visit`)
        .send({ visitorId, source, medium: 'offline', campaign: 'promo-invierno' })
        .expect(204);
    await visit('visitor-flyer-1', 'flyer');
    await visit('visitor-flyer-2', 'flyer');
    await visit('visitor-insta-1', 'instagram');

    // El cliente ya existía como contacto (sin origen): la reserva le pone el de la landing.
    const email = `ana-promo-${Date.now()}@e2e.local`;
    await http()
      .post('/leads')
      .set(a)
      .send({ source: 'manual', firstName: 'Ana', email })
      .expect(201);
    const booked = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: fac.facilityId,
        unitTypeId: fac.unitTypeId,
        startDate: '2026-03-15',
        months: 1,
        couponCode: 'DIEZ',
        utmSource: 'flyer',
        utmMedium: 'offline',
        utmCampaign: 'promo-invierno',
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
        signerName: 'Ana Ruiz',
        method: 'typed',
        typedSignature: 'Ana Ruiz',
        accept: true,
        generalTermsHash: await generalTermsHash(app, booked.body.signingToken),
      })
      .expect(201);
    const invoices = await http().get('/invoices').set(a);
    const inv = (
      invoices.body as { id: string; contractId: string; kind: string; total: number }[]
    ).find((i) => i.contractId === booked.body.contractId && i.kind === 'invoice')!;
    await http()
      .post(`/invoices/${inv.id}/mark-paid`)
      .set(a)
      .send({ amount: Number(inv.total), methodType: 'cash' })
      .expect(200);

    const stats = await http().get(`/promo-landings/${id}/stats?days=30`).set(a);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({
      visits: 3,
      visitors: 3,
      bookings: 1,
      signed: 1,
      paid: 1,
      revenue: Number(inv.total),
      couponUses: 1,
    });
    expect(stats.body.bySource).toEqual([
      {
        source: 'flyer',
        visits: 2,
        visitors: 2,
        requests: 0,
        bookings: 1,
        signed: 1,
        paid: 1,
        revenue: Number(inv.total),
      },
      {
        source: 'instagram',
        visits: 1,
        visitors: 1,
        requests: 0,
        bookings: 0,
        signed: 0,
        paid: 0,
        revenue: 0,
      },
    ]);
  });

  it('formulario de la landing, vista previa del borrador y aislamiento', async () => {
    const owner = await registerVerifiedUser(app, 'promo-lead');
    const a = auth(owner.accessToken);
    await setTenantFeatureOverride(owner.slug, 'web_premium', true);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 40,
    });
    const created = await http()
      .post('/promo-landings')
      .set(a)
      .send({
        name: 'Apertura',
        slug: 'apertura',
        headline: 'Abrimos',
        facilityIds: [fac.facilityId],
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const lead = (body: Record<string, unknown>) =>
      http().post(`/public/landing/${owner.slug}/promo/apertura/lead`).send(body);
    const good = {
      name: 'Luis Pérez',
      phone: '600 123 456',
      unitTypeId: fac.unitTypeId,
      acceptPrivacy: true,
      utmSource: 'Instagram',
    };

    // Borrador: no se sirve ni admite solicitudes; con el enlace de vista previa sí se ve.
    expect((await http().get(`/public/landing/${owner.slug}/promo/apertura`)).status).toBe(404);
    expect((await lead(good)).status).toBe(404);
    const prev = await http().post(`/promo-landings/${id}/preview`).set(a);
    expect(prev.status).toBe(200);
    const token = new URL(prev.body.url as string).searchParams.get('preview')!;
    const seen = await http()
      .get(`/public/landing/${owner.slug}/promo/apertura`)
      .query({ preview: token });
    expect(seen.status).toBe(200);
    expect(seen.body.promo.preview).toBe(true);
    expect(
      (
        await http()
          .get(`/public/landing/${owner.slug}/promo/apertura`)
          .query({ preview: `${token}x` })
      ).status,
    ).toBe(404);

    await http().patch(`/promo-landings/${id}`).set(a).send({ isActive: true }).expect(200);

    // Sin privacidad o con la trampa llena se rechaza.
    expect((await lead({ ...good, acceptPrivacy: false })).status).toBe(400);
    expect((await lead({ ...good, hp: 'bot' })).status).toBe(400);
    // Un tamaño de otro negocio no vale.
    const other = await registerVerifiedUser(app, 'promo-lead-b');
    const otherFac = await createFacilityWithUnits(app, other.accessToken, {
      unitsCount: 1,
      pricePerUnit: 40,
    });
    const foreign = await lead({ ...good, unitTypeId: otherFac.unitTypeId });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('invalid_unit_type');

    expect((await lead(good)).status).toBe(200);
    const admin = app.get(PrismaAdminService);
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const leads = await admin.lead.findMany({ where: { tenantId: tenant.id, source: 'landing' } });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      firstName: 'Luis',
      lastName: 'Pérez',
      phone: '600123456',
      utmSource: 'instagram',
      utmCampaign: 'promo-apertura',
      preferredUnitTypeId: fac.unitTypeId,
      preferredFacilityId: fac.facilityId,
    });
    // La misma persona otra vez completa su contacto en vez de duplicarlo.
    expect((await lead(good)).status).toBe(200);
    expect(await admin.lead.count({ where: { tenantId: tenant.id, source: 'landing' } })).toBe(1);

    const stats = await http().get(`/promo-landings/${id}/stats`).set(a);
    expect(stats.body.requests).toBe(1);
    expect(stats.body.bySource).toEqual([
      expect.objectContaining({ source: 'instagram', requests: 1 }),
    ]);

    // Con el formulario apagado no se admiten solicitudes.
    await http()
      .patch(`/promo-landings/${id}`)
      .set(a)
      .send({ content: { contact: { enabled: false } } })
      .expect(200);
    expect((await lead(good)).status).toBe(404);
  });
});
