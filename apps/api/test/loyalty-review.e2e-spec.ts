import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ReferralsService } from '../src/modules/referrals/referrals.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Revisión de Fidelización: promociones, cupones, referidos y valoraciones. */
describe('Fidelización: revisión (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  const person = (tag: string) => ({
    firstName: 'Eva',
    lastName: 'Sanz',
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`,
    phone: '600111222',
    documentNumber: '12345678Z',
  });

  /** Reserva online firmada (sin pagar). */
  async function bookAndSign(
    slug: string,
    base: { facilityId: string; unitTypeId: string },
    extra: Record<string, unknown> = {},
  ): Promise<{ email: string; status: number }> {
    const customer = person('reserva');
    const booked = await http()
      .post(`/public/move-in/book/${slug}`)
      .send({ ...base, startDate: '2026-12-01', months: 1, customer, ...extra });
    if (booked.status !== 201) return { email: customer.email, status: booked.status };
    const token = booked.body.signingToken as string;
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Eva Sanz',
        method: 'typed',
        typedSignature: 'Eva Sanz',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      })
      .expect(201);
    return { email: customer.email, status: 201 };
  }

  it('promociones: validación, uso devuelto, web y reserva online', async () => {
    const owner = await registerVerifiedUser(app, 'loyp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 4,
      pricePerUnit: 50,
    });
    const base = { facilityId: fac.facilityId, unitTypeId: fac.unitTypeId };
    const customerId = await createCustomer(app, owner.accessToken);

    const promo = await http()
      .post('/promotions')
      .set(auth)
      .send({
        code: 'UNAVEZ',
        name: 'Una vez',
        discountType: 'percentage',
        discountValue: 20,
        maxUses: 1,
      })
      .expect(201);
    expect(promo.body.announceOnWeb).toBe(false);
    const id = promo.body.id as string;

    // Cambiarla no admite lo que no admite crearla.
    const over = await http().patch(`/promotions/${id}`).set(auth).send({ discountValue: 150 });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('invalid_promotion');
    await http()
      .patch(`/promotions/${id}`)
      .set(auth)
      .send({ discountType: 'free_months', discountValue: 1.5 })
      .expect(400);
    await http()
      .patch(`/promotions/${id}`)
      .set(auth)
      .send({ validFrom: '2026-12-31T00:00:00.000Z', validUntil: '2026-01-01T00:00:00.000Z' })
      .expect(400);

    // Un borrador cancelado devuelve el uso.
    const draftInput = {
      customerId,
      unitId: fac.unitIds[0],
      startDate: '2026-12-01',
      priceMonthly: 50,
      promotionCode: 'UNAVEZ',
    };
    const draft = await http().post('/contracts').set(auth).send(draftInput).expect(201);
    expect(draft.body.discountAmount).toBe(10);
    await http().post(`/contracts/${draft.body.id}/cancel`).set(auth).send({ reason: 'x' });
    const again = await http().post('/contracts').set(auth).send(draftInput);
    expect(again.status).toBe(201);
    // Ya usada: no se borra.
    const del = await http().delete(`/promotions/${id}`).set(auth);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('promotion_in_use');

    // Meses gratis con pago semestral o anual: no.
    await http()
      .post('/promotions')
      .set(auth)
      .send({
        code: 'DOSGRATIS',
        name: 'Dos gratis',
        discountType: 'free_months',
        discountValue: 2,
      })
      .expect(201);
    const check = await http()
      .post('/promotions/validate')
      .set(auth)
      .send({ code: 'DOSGRATIS', monthlyPrice: 50, billingIntervalMonths: 12 });
    expect(check.body).toMatchObject({ valid: false, reason: 'not_with_prepay' });
    const annual = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: fac.unitIds[1],
      startDate: '2026-12-01',
      priceMonthly: 50,
      promotionCode: 'DOSGRATIS',
      billingIntervalMonths: 12,
      prepayDiscountPct: 10,
    });
    expect(annual.status).toBe(400);
    expect(annual.body.code).toBe('promotion_not_with_prepay');

    // La oferta de un trastero sigue en pie si el borrador se cancela, y no
    // sale entre las promociones.
    const offer = await http()
      .post('/promotions/unit-offers')
      .set(auth)
      .send({ unitId: fac.unitIds[1], freeMonths: 1, validDays: 30 })
      .expect(201);
    const withOffer = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: fac.unitIds[1],
        startDate: '2026-12-01',
        priceMonthly: 50,
        promotionCode: offer.body.code,
      })
      .expect(201);
    await http().post(`/contracts/${withOffer.body.id}/cancel`).set(auth).send({ reason: 'x' });
    const offers = await http().get(`/promotions/unit-offers?unitId=${fac.unitIds[1]}`).set(auth);
    expect(offers.body).toHaveLength(1);
    const list = await http().get('/promotions').set(auth);
    expect((list.body as { code: string }[]).map((p) => p.code).sort()).toEqual([
      'DOSGRATIS',
      'UNAVEZ',
    ]);

    // La web solo anuncia (y la reserva solo admite) la que el negocio marca.
    await http()
      .post('/promotions')
      .set(auth)
      .send({ code: 'WEB20', name: 'Web 20', discountType: 'percentage', discountValue: 20 })
      .expect(201);
    expect((await http().get(`/public/landing/${owner.slug}`)).body.activePromotion).toBeNull();
    const hidden = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 1, couponCode: 'WEB20' });
    expect(hidden.body.coupon).toMatchObject({ valid: false });
    const created = await http().get('/promotions').set(auth);
    const webPromo = (created.body as { id: string; code: string }[]).find(
      (p) => p.code === 'WEB20',
    )!;
    await http()
      .patch(`/promotions/${webPromo.id}`)
      .set(auth)
      .send({ announceOnWeb: true })
      .expect(200);
    expect((await http().get(`/public/landing/${owner.slug}`)).body.activePromotion).toMatchObject({
      code: 'WEB20',
    });
    const quote = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 1, couponCode: 'web20' });
    expect(quote.body.coupon).toMatchObject({ code: 'WEB20', valid: true });
    expect(quote.body.promotion).toMatchObject({
      code: 'WEB20',
      listPrice: 50,
      monthlyDiscount: 10,
      freeMonths: 0,
    });
    expect(quote.body.monthlyPrice).toBe(40);
    const booked = await bookAndSign(owner.slug, base, { couponCode: 'WEB20' });
    expect(booked.status).toBe(201);
    const contract = await db.contract.findFirstOrThrow({
      where: { tenant: { slug: owner.slug }, customer: { email: booked.email } },
      select: { discountAmount: true, promotion: { select: { code: true } } },
    });
    expect(Number(contract.discountAmount)).toBe(10);
    expect(contract.promotion?.code).toBe('WEB20');

    // Quien solo ve unos locales no cambia lo que vale para todo el negocio.
    const manager = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [fac.facilityId],
    });
    const scoped = await http()
      .post('/promotions')
      .set(manager)
      .send({ code: 'DEMGR', name: 'x', discountType: 'percentage', discountValue: 100 });
    expect(scoped.status).toBe(403);
    expect(scoped.body.code).toBe('facility_scope_restricted');
    await http()
      .post('/coupons')
      .set(manager)
      .send({ code: 'CUPMGR', name: 'x', discountType: 'percentage', discountValue: 10 })
      .expect(403);

    // Queda en el registro de actividad.
    await http()
      .post('/coupons')
      .set(auth)
      .send({ code: 'CUPON10', name: 'Diez', discountType: 'percentage', discountValue: 10 })
      .expect(201);
    const actions = await db.auditLog.findMany({
      where: {
        tenant: { slug: owner.slug },
        action: { in: ['promotion.created', 'coupon.created'] },
      },
      select: { action: true },
    });
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(['promotion.created', 'coupon.created']),
    );
  });

  it('cupones: quien reservó y nunca pagó sigue siendo cliente nuevo', async () => {
    const owner = await registerVerifiedUser(app, 'loyc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 50,
    });
    await http()
      .post('/coupons')
      .set(auth)
      .send({
        code: 'NUEVOS',
        name: 'Nuevos',
        discountType: 'percentage',
        discountValue: 10,
        newCustomersOnly: true,
      })
      .expect(201);
    const booked = await bookAndSign(owner.slug, {
      facilityId: fac.facilityId,
      unitTypeId: fac.unitTypeId,
    });
    const contract = await db.contract.findFirstOrThrow({
      where: { tenant: { slug: owner.slug }, customer: { email: booked.email } },
      select: { id: true, customerId: true },
    });
    await http().post(`/contracts/${contract.id}/cancel`).set(auth).send({ reason: 'no pagó' });
    const validate = await http()
      .post('/coupons/validate')
      .set(auth)
      .send({ code: 'NUEVOS', unitId: fac.unitIds[1], months: 1, customerId: contract.customerId });
    expect(validate.body.valid).toBe(true);
  });

  it('referidos: se gana al pagar, se reparte y respeta el alcance', async () => {
    const owner = await registerVerifiedUser(app, 'loyr');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
      pricePerUnit: 40,
    });
    const base = { facilityId: fac.facilityId, unitTypeId: fac.unitTypeId };
    const referrerId = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: referrerId }, fac.facilityId);
    const service = app.get(ReferralsService);
    const code = await service.ensureCode(tenant.id, referrerId);

    // Programa apagado: ni se pide ni se registra.
    const availability = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    expect(availability.body.referralEnabled).toBe(false);
    await bookAndSign(owner.slug, base, { referralCode: code });
    expect((await http().get('/referrals').set(auth)).body).toHaveLength(0);
    expect((await http().get(`/referrals/customers/${referrerId}/code`).set(auth)).body).toEqual({
      enabled: false,
      referralCode: null,
    });

    // Un porcentaje no pasa de 100.
    await http()
      .patch('/settings/tenant/referrals')
      .set(auth)
      .send({ referralEnabled: true, referralRewardType: 'percentage', referralRewardValue: 250 })
      .expect(400);
    await http()
      .patch('/settings/tenant/referrals')
      .set(auth)
      .send({ referralEnabled: true, referralRewardType: 'fixed', referralRewardValue: 50 })
      .expect(200);
    expect((await http().get(`/referrals/customers/${referrerId}/code`).set(auth)).body).toEqual({
      enabled: true,
      referralCode: code,
    });

    // Reserva con el código, firma y no paga: nada de recompensa.
    const friend = await bookAndSign(owner.slug, base, { referralCode: code });
    await sleep(800);
    const pending = await http().get('/referrals').set(auth);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({
      status: 'pending',
      reward: null,
      referrerActive: true,
    });

    // Se cancela la reserva: el referido no llegó a nada.
    const contract = await db.contract.findFirstOrThrow({
      where: { tenantId: tenant.id, customer: { email: friend.email } },
      select: { id: true },
    });
    await http().post(`/contracts/${contract.id}/cancel`).set(auth).send({ reason: 'no pagó' });
    let status = '';
    for (let i = 0; i < 20 && status !== 'cancelled'; i++) {
      await sleep(200);
      status = (await http().get('/referrals').set(auth)).body[0].status as string;
    }
    expect(status).toBe('cancelled');

    // Una recompensa de 50 € con una cuota de 40 € se reparte en dos facturas.
    const referral = await db.referral.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await db.referral.update({
      where: { id: referral.id },
      data: { status: 'converted', convertedAt: new Date(), rewardType: 'fixed', rewardValue: 50 },
    });
    const first = await service.claimRewardsForInvoice(tenant.id, referrerId, 40);
    expect(first.discount).toBe(40);
    // Si la factura no sale, lo descontado vuelve.
    await service.settleRewards(first.claims, null);
    const retry = await service.claimRewardsForInvoice(tenant.id, referrerId, 40);
    expect(retry.discount).toBe(40);
    const second = await service.claimRewardsForInvoice(tenant.id, referrerId, 40);
    expect(second.discount).toBe(10);
    expect((await service.claimRewardsForInvoice(tenant.id, referrerId, 40)).discount).toBe(0);
    const row = (await http().get('/referrals').set(auth)).body[0];
    expect(row.reward).toMatchObject({ type: 'fixed', value: 50, appliedAmount: 50 });
    expect(row.reward.appliedAt).not.toBeNull();

    // Quien solo ve otro local no ve a estos inquilinos.
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const scoped = await scopedUser(app, owner, { role: 'staff', facilityIds: [other.facilityId] });
    expect((await http().get('/referrals').set(scoped)).body).toHaveLength(0);
    expect((await http().get('/referrals/stats').set(scoped)).body.total).toBe(0);
    await http().get(`/referrals/customers/${referrerId}/code`).set(scoped).expect(404);
  });

  it('valoraciones: envío, permiso para publicar, avisos y alcance', async () => {
    const owner = await registerVerifiedUser(app, 'loyv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin email no hay a quién enviársela.
    const noEmail = await http()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Sin', lastName: 'Correo', country: 'ES' })
      .expect(201);
    const none = await http()
      .post('/reviews/request')
      .set(auth)
      .send({ customerId: noEmail.body.id, channel: 'email' });
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('customer_without_email');

    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: customerId }, fac.facilityId);
    const requested = await http()
      .post('/reviews/request')
      .set(auth)
      .send({ customerId, channel: 'email' })
      .expect(201);
    const token = (requested.body.reviewUrl as string).split('/review/')[1]!;
    // A los pocos días no se le escribe otra vez.
    const repeat = await http()
      .post('/reviews/request')
      .set(auth)
      .send({ customerId, channel: 'email' });
    expect(repeat.status).toBe(409);
    expect(repeat.body.code).toBe('review_recently_requested');

    // El historial trae el enlace para copiarlo; reenviar, como mucho una vez al día.
    const list = await http().get('/reviews').set(auth);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].reviewUrl).toContain(`/review/${token}`);
    const reviewId = list.body.items[0].id as string;
    await http().post(`/reviews/${reviewId}/resend`).set(auth).expect(409);
    await db.review.update({
      where: { id: reviewId },
      data: {
        requestedAt: new Date(Date.now() - 2 * 86_400_000),
        tokenExpiresAt: new Date(Date.now() - 1000),
      },
    });
    // Caducada: sale en su filtro y no en el de pendientes.
    expect((await http().get('/reviews?status=pending').set(auth)).body.items).toHaveLength(0);
    expect((await http().get('/reviews?status=expired').set(auth)).body.items).toHaveLength(1);
    const resent = await http().post(`/reviews/${reviewId}/resend`).set(auth);
    expect(resent.status).toBe(200);
    expect(resent.body.status).toBe('pending');

    // Dos envíos a la vez cuentan como uno; una nota baja avisa al equipo.
    const submit = () =>
      http()
        .post(`/public/reviews/${token}`)
        .send({ npsScore: 2, rating: 1, comment: 'No me ha gustado' });
    const both = await Promise.all([submit(), submit()]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 404]);
    let low = false;
    for (let i = 0; i < 20 && !low; i++) {
      const notes = await http().get('/notifications').set(auth);
      low = (notes.body.items as { type: string }[]).some((n) => n.type === 'review.low_score');
      if (!low) await sleep(150);
    }
    expect(low).toBe(true);

    // Sin permiso de su autor no se publica.
    const noConsent = await http()
      .patch(`/reviews/${reviewId}/web`)
      .set(auth)
      .send({ published: true });
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.code).toBe('review_without_consent');
    const happyId = await createCustomer(app, owner.accessToken);
    const happy = await http()
      .post('/reviews/request')
      .set(auth)
      .send({ customerId: happyId, channel: 'email' })
      .expect(201);
    await http()
      .post(`/public/reviews/${(happy.body.reviewUrl as string).split('/review/')[1]}`)
      .send({ npsScore: 10, rating: 5, comment: 'Estupendo', publishConsent: true })
      .expect(201);
    const published = await http()
      .patch(`/reviews/${happy.body.id}/web`)
      .set(auth)
      .send({ published: true });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ publishedOnWeb: true, publishConsent: true });

    // Publicar pide permiso de escritura.
    const readonly = await scopedUser(app, owner, { role: 'readonly', facilityIds: [] });
    await http()
      .patch(`/reviews/${happy.body.id}/web`)
      .set(readonly)
      .send({ published: false })
      .expect(403);

    // Quien solo ve otro local no ve la valoración de este inquilino ni se la pide.
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const scoped = await scopedUser(app, owner, { role: 'staff', facilityIds: [other.facilityId] });
    const seen = await http().get('/reviews').set(scoped);
    expect((seen.body.items as { customerId: string }[]).map((r) => r.customerId)).toEqual([
      happyId,
    ]);
    await http()
      .post('/reviews/request')
      .set(scoped)
      .send({ customerId, channel: 'email' })
      .expect(404);
  });
});
