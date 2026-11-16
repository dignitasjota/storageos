import { randomBytes, randomUUID } from 'node:crypto';

import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
import { BookingRecoveryService } from '../src/modules/move-in/booking-recovery.service';
import { ReferralsService } from '../src/modules/referrals/referrals.service';
import { RetentionService } from '../src/modules/retention/retention.service';
import { ReviewsService } from '../src/modules/reviews/reviews.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

/** Fidelización: las mejoras (promociones, cupones, referidos y valoraciones). */
describe('Fidelización: mejoras (e2e)', () => {
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
  ): Promise<{ email: string; status: number; code?: string }> {
    const customer = person('reserva');
    const booked = await http()
      .post(`/public/move-in/book/${slug}`)
      .send({ ...base, startDate: '2026-12-01', months: 1, customer, ...extra });
    if (booked.status !== 201) {
      return { email: customer.email, status: booked.status, code: booked.body.code };
    }
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

  /** Cobra en efectivo la primera factura de quien reservó. */
  async function payFirstInvoice(
    auth: Record<string, string>,
    tenantId: string,
    email: string,
  ): Promise<void> {
    // La de una reserva online es un borrador hasta que se cobra.
    const invoice = await db.invoice.findFirstOrThrow({
      where: { tenantId, kind: 'invoice', customer: { email } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, total: true, amountPaid: true },
    });
    await http()
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(invoice.total) - Number(invoice.amountPaid), methodType: 'cash' })
      .expect(200);
  }

  it('promociones: duración, condiciones, edición y resultados', async () => {
    const owner = await registerVerifiedUser(app, 'lfp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 4,
      pricePerUnit: 50,
    });
    const otherType = await http()
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Grande', defaultPriceMonthly: 90 })
      .expect(201);
    const bigUnit = await http()
      .post('/units')
      .set(auth)
      .send({
        facilityId: fac.facilityId,
        unitTypeId: otherType.body.id,
        code: 'G-1',
        widthM: 3,
        depthM: 4,
        heightM: 2.5,
        basePriceMonthly: 90,
      })
      .expect(201);
    const customerId = await createCustomer(app, owner.accessToken);

    // Meses gratis con duración, y un tipo que no existe: no.
    await http()
      .post('/promotions')
      .set(auth)
      .send({
        code: 'MAL',
        name: 'Mal',
        discountType: 'free_months',
        discountValue: 1,
        durationMonths: 2,
      })
      .expect(400);
    const ghost = await http()
      .post('/promotions')
      .set(auth)
      .send({
        code: 'FANTASMA',
        name: 'Fantasma',
        discountType: 'percentage',
        discountValue: 10,
        unitTypeIds: [randomUUID()],
      });
    expect(ghost.status).toBe(400);
    expect(ghost.body.code).toBe('invalid_scope');

    const promo = await http()
      .post('/promotions')
      .set(auth)
      .send({
        code: 'TRESMESES',
        name: 'Tres meses',
        discountType: 'percentage',
        discountValue: 20,
        durationMonths: 3,
        unitTypeIds: [fac.unitTypeId],
        oncePerCustomer: true,
      })
      .expect(201);
    expect(promo.body).toMatchObject({
      durationMonths: 3,
      unitTypeIds: [fac.unitTypeId],
      oncePerCustomer: true,
      newCustomersOnly: false,
    });
    const id = promo.body.id as string;

    const check = (extra: Record<string, unknown>) =>
      http()
        .post('/promotions/validate')
        .set(auth)
        .send({
          code: 'TRESMESES',
          monthlyPrice: 50,
          unitId: fac.unitIds[0],
          customerId,
          ...extra,
        });
    expect((await check({})).body).toMatchObject({
      valid: true,
      discountAmount: 10,
      durationMonths: 3,
    });
    expect((await check({ billingIntervalMonths: 12 })).body).toMatchObject({
      valid: false,
      reason: 'duration_too_short',
    });
    expect((await check({ unitId: bigUnit.body.id, monthlyPrice: 90 })).body).toMatchObject({
      valid: false,
      reason: 'unit_type',
    });

    // Con un primer pago de 6 meses no se puede: el descuento dura 3.
    const draftInput = {
      customerId,
      unitId: fac.unitIds[0],
      startDate: '2026-12-01',
      priceMonthly: 50,
      promotionCode: 'TRESMESES',
    };
    const long = await http()
      .post('/contracts')
      .set(auth)
      .send({ ...draftInput, firstPaymentMonths: 6 });
    expect(long.status).toBe(400);
    expect(long.body.code).toBe('promotion_duration_too_short');

    // El contrato lleva el descuento y cuándo se acaba.
    const contract = await http().post('/contracts').set(auth).send(draftInput).expect(201);
    expect(contract.body.discountAmount).toBe(10);
    expect(contract.body.discountReason).toBe('Promoción TRESMESES (los 3 primeros meses)');
    expect(String(contract.body.discountExpiresAt)).toContain('2027-03-01');
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).expect(200);

    // Un uso por cliente.
    expect((await check({ unitId: fac.unitIds[1] })).body).toMatchObject({
      valid: false,
      reason: 'already_used',
    });
    const second = await http()
      .post('/contracts')
      .set(auth)
      .send({ ...draftInput, unitId: fac.unitIds[1] });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('promotion_already_used');

    // Ya usada: se cambian las condiciones, no el descuento.
    const locked = await http().patch(`/promotions/${id}`).set(auth).send({ discountValue: 30 });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('promotion_discount_locked');
    const edited = await http()
      .patch(`/promotions/${id}`)
      .set(auth)
      .send({ name: 'Tres meses al 20', unitTypeIds: [], newCustomersOnly: true, maxUses: 5 })
      .expect(200);
    expect(edited.body).toMatchObject({
      name: 'Tres meses al 20',
      unitTypeIds: [],
      newCustomersOnly: true,
      maxUses: 5,
      durationMonths: 3,
    });

    const results = await http().get(`/promotions/${id}/results`).set(auth).expect(200);
    expect(results.body).toMatchObject({ liveContracts: 1, monthlyCost: 10, monthlyRevenue: 40 });
    expect(results.body.contracts[0]).toMatchObject({
      customerId,
      monthlyDiscount: 10,
      status: 'active',
    });

    // La factura del cuarto mes ya sale sin descuento, aunque el repaso que lo
    // quita del contrato no haya pasado todavía.
    const jobs = app.get(BillingJobsService);
    const rentOf = async (month: string, lastDay: string) => {
      await jobs.processGenerateRecurring({
        tenantId: owner.tenantId,
        periodStart: `${month}-01`,
        periodEnd: `${month}-${lastDay}`,
      });
      const invoice = await db.invoice.findFirstOrThrow({
        where: { contractId: contract.body.id, periodStart: new Date(`${month}-01`) },
      });
      return Number(invoice.subtotal);
    };
    expect(await rentOf('2027-02', '28')).toBe(40);
    expect(await rentOf('2027-03', '31')).toBe(50);

    // Pasados los 3 meses el contrato vuelve solo a su precio.
    await db.contract.update({
      where: { id: contract.body.id },
      data: { discountExpiresAt: new Date(Date.now() - DAY) },
    });
    await app.get(RetentionService).revertExpiredDiscounts();
    const after = await http().get(`/contracts/${contract.body.id}`).set(auth);
    expect(after.body.discountAmount).toBe(0);
    const event = await db.contractEvent.findFirst({
      where: { contractId: contract.body.id, eventType: 'price_changed' },
      orderBy: { occurredAt: 'desc' },
    });
    expect((event?.payload as { reason?: string })?.reason).toBe('promotion_discount_expired');
  }, 90_000);

  it('cupones: en la web, personales, resultados y reserva sin terminar', async () => {
    const owner = await registerVerifiedUser(app, 'lfc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 3,
      pricePerUnit: 50,
    });
    const base = { facilityId: fac.facilityId, unitTypeId: fac.unitTypeId };

    // Un cupón anunciado sale en el aviso de la web.
    const coupon = await http()
      .post('/coupons')
      .set(auth)
      .send({
        code: 'TRESXDOS',
        name: 'Tres por dos',
        discountType: 'free_months',
        discountValue: 1,
        minMonths: 3,
        announceOnWeb: true,
      })
      .expect(201);
    expect(coupon.body).toMatchObject({ announceOnWeb: true, kind: 'standard' });
    const landing = await http().get(`/public/landing/${owner.slug}`).expect(200);
    expect(landing.body.activePromotion).toMatchObject({
      code: 'TRESXDOS',
      kind: 'coupon',
      minMonths: 3,
      discountType: 'free_months',
    });
    await http()
      .patch(`/coupons/${coupon.body.id}`)
      .set(auth)
      .send({ announceOnWeb: false })
      .expect(200);
    expect((await http().get(`/public/landing/${owner.slug}`)).body.activePromotion).toBeNull();

    // Cupón personal: un uso, con caducidad y código del sistema.
    const personal = await http()
      .post('/coupons/personal')
      .set(auth)
      .send({
        personalFor: 'Marta López',
        discountType: 'percentage',
        discountValue: 15,
        validDays: 5,
      })
      .expect(201);
    expect(personal.body).toMatchObject({
      kind: 'personal',
      personalFor: 'Marta López',
      maxUses: 1,
      discountValue: 15,
    });
    expect(personal.body.code).toMatch(/^P-[A-Z2-9]{6}$/);
    const validMs = new Date(personal.body.validUntil as string).getTime() - Date.now();
    expect(validMs).toBeGreaterThan(4 * DAY);
    expect(validMs).toBeLessThan(6 * DAY);

    // Se usa en una reserva online y ya no vale otra vez.
    const used = await bookAndSign(owner.slug, base, { couponCode: personal.body.code });
    expect(used.status).toBe(201);
    const again = await bookAndSign(owner.slug, base, { couponCode: personal.body.code });
    expect(again.status).toBe(400);
    expect(again.code).toBe('coupon_not_valid');

    const results = await http().get(`/coupons/${personal.body.id}/results`).set(auth).expect(200);
    expect(results.body).toMatchObject({ uses: 1, liveContracts: 1, monthlyRevenue: 50 });
    expect(results.body.totalDiscount).toBe(7.5);

    // Reserva sin terminar: el recordatorio lleva un cupón personal.
    expect((await http().get('/coupons/settings').set(auth)).body).toEqual({
      bookingRecoveryCouponPct: 0,
      bookingRecoveryCouponDays: 2,
    });
    await http()
      .put('/coupons/settings')
      .set(auth)
      .send({ bookingRecoveryCouponPct: 150, bookingRecoveryCouponDays: 3 })
      .expect(400);
    await http()
      .put('/coupons/settings')
      .set(auth)
      .send({ bookingRecoveryCouponPct: 10, bookingRecoveryCouponDays: 3 })
      .expect(200);
    const email = `a-medias-${Date.now()}@e2e.local`;
    await http()
      .post(`/public/move-in/book/${owner.slug}/lead`)
      .send({ email, firstName: 'Nora', ...base })
      .expect(201);
    const lead = await db.lead.findFirstOrThrow({ where: { tenantId: tenant.id, email } });
    await db.lead.update({
      where: { id: lead.id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    await app.get(BookingRecoveryService).sendDueReminders();
    const offered = await db.coupon.findFirstOrThrow({
      where: { tenantId: tenant.id, kind: 'personal', personalFor: email },
    });
    expect(Number(offered.discountValue)).toBe(10);
    expect(offered.maxUses).toBe(1);
    const comm = await db.communication.findFirstOrThrow({
      where: { tenantId: tenant.id, leadId: lead.id, source: 'booking_recovery' },
    });
    expect(comm.bodyText).toContain(offered.code);
    expect(comm.bodyText).toContain(`coupon=${offered.code}`);

    // En la lista salen los personales con su destinatario.
    const list = await http().get('/coupons').set(auth);
    const kinds = (list.body as { kind: string }[]).map((c) => c.kind).sort();
    expect(kinds).toEqual(['personal', 'personal', 'standard']);
  }, 90_000);

  it('referidos: premio al recomendado, enlace, tope anual y ranking', async () => {
    const owner = await registerVerifiedUser(app, 'lfr');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 4,
      pricePerUnit: 50,
    });
    const base = { facilityId: fac.facilityId, unitTypeId: fac.unitTypeId };
    const referrerId = await createCustomer(app, owner.accessToken);
    await signedContractFor(app, owner.accessToken, { id: referrerId }, fac.facilityId);
    const service = app.get(ReferralsService);

    const settings = await http()
      .patch('/settings/tenant/referrals')
      .set(auth)
      .send({
        referralEnabled: true,
        referralRewardType: 'fixed',
        referralRewardValue: 20,
        referralFriendRewardType: 'percentage',
        referralFriendRewardValue: 10,
        referralMaxRewardsPerYear: 1,
      })
      .expect(200);
    expect(settings.body).toMatchObject({
      referralFriendRewardType: 'percentage',
      referralFriendRewardValue: 10,
      referralMaxRewardsPerYear: 1,
    });

    // El código y el enlace para compartir.
    const share = await http().get(`/referrals/customers/${referrerId}/code`).set(auth);
    const code = share.body.referralCode as string;
    expect(share.body.enabled).toBe(true);
    expect(share.body.shareUrl).toContain(`/book/${owner.slug}?ref=${code}`);
    const portal = await service.getPortalView(tenant.id, referrerId);
    expect(portal).toMatchObject({
      enabled: true,
      referralCode: code,
      reward: { type: 'fixed', value: 20 },
      friendReward: { type: 'percentage', value: 10 },
    });

    // Con el código de un inquilino, descuento en el primer pago.
    const quote = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 1, referralCode: code });
    expect(quote.body).toMatchObject({ referralFriend: true, discountAmount: 5, rentTotal: 45 });
    const friendCode = quote.body.coupon.code as string;
    // Un código que no es de nadie no descuenta nada.
    const none = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 1, referralCode: 'NOEXISTE' });
    expect(none.body.discountAmount).toBe(0);
    expect(none.body.referralFriend).toBeUndefined();
    // Y el cupón del recomendado no vale escribiéndolo a mano.
    const typed = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 1, couponCode: friendCode });
    expect(typed.body.coupon).toMatchObject({ valid: false });
    expect(typed.body.discountAmount).toBe(0);
    // Ni sale entre los cupones del negocio.
    expect((await http().get('/coupons').set(auth)).body).toHaveLength(0);

    // Primer recomendado: reserva con descuento, paga y da la recompensa.
    const first = await bookAndSign(owner.slug, base, { referralCode: code });
    expect(first.status).toBe(201);
    const firstInvoice = await db.invoice.findFirstOrThrow({
      where: { tenantId: tenant.id, kind: 'invoice', customer: { email: first.email } },
    });
    expect(Number(firstInvoice.subtotal)).toBe(45);
    await payFirstInvoice(auth, tenant.id, first.email);
    // Segundo recomendado: con el tope de una al año ya no hay recompensa.
    const second = await bookAndSign(owner.slug, base, { referralCode: code });
    expect(second).toMatchObject({ status: 201 });
    await payFirstInvoice(auth, tenant.id, second.email);

    type Row = {
      status: string;
      reward: { value: number } | null;
      rewardSkippedReason: string | null;
    };
    let rows: Row[] = [];
    for (let i = 0; i < 30; i++) {
      rows = (await http().get('/referrals').set(auth)).body as Row[];
      if (rows.length === 2 && rows.every((r) => r.status === 'converted')) break;
      await sleep(200);
    }
    expect(rows.map((r) => r.status)).toEqual(['converted', 'converted']);
    expect(rows.filter((r) => r.reward?.value === 20)).toHaveLength(1);
    expect(rows.filter((r) => r.rewardSkippedReason === 'yearly_cap')).toHaveLength(1);

    const top = await http().get('/referrals/top').set(auth).expect(200);
    expect(top.body).toHaveLength(1);
    expect(top.body[0]).toMatchObject({
      customerId: referrerId,
      referred: 2,
      converted: 2,
      rewardsFixedTotal: 20,
    });

    // Sin premio al recomendado, el código ya no descuenta.
    await http()
      .patch('/settings/tenant/referrals')
      .set(auth)
      .send({
        referralEnabled: true,
        referralRewardType: 'fixed',
        referralRewardValue: 20,
        referralFriendRewardType: null,
      })
      .expect(200);
    const off = await http()
      .post(`/public/move-in/book/${owner.slug}/quote`)
      .send({ ...base, months: 1, referralCode: code });
    expect(off.body.discountAmount).toBe(0);
  }, 120_000);

  it('valoraciones: salida, recordatorio, anual, cifras y seguimiento', async () => {
    const owner = await registerVerifiedUser(app, 'lfv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const { contractId } = await signedContractFor(
      app,
      owner.accessToken,
      { id: customerId },
      fac.facilityId,
    );
    const reviews = app.get(ReviewsService);
    await http()
      .patch('/settings/tenant/referrals')
      .set(auth)
      .send({ referralEnabled: true, referralRewardType: 'fixed', referralRewardValue: 15 })
      .expect(200);
    // Tarea automática al recibir una mala valoración.
    const rules = (await http().get('/tasks/auto-rules').set(auth)).body;
    expect(rules.lowReview).toEqual({ enabled: false, days: 1 });
    await http()
      .put('/tasks/auto-rules')
      .set(auth)
      .send({ ...rules, lowReview: { enabled: true, days: 2 } })
      .expect(200);

    const newReview = (source: string | null, requestedAt = new Date()) =>
      db.review.create({
        data: {
          tenantId: tenant.id,
          customerId,
          contractId,
          token: randomBytes(24).toString('hex'),
          tokenExpiresAt: new Date(Date.now() + 30 * DAY),
          channel: 'email',
          source,
          requestedAt,
        },
      });

    // Encuesta de salida: pregunta el motivo y un detractor genera una tarea.
    const exit = await newReview('reviews.exit');
    const ctx = await http().get(`/public/reviews/${exit.token}`).expect(200);
    expect(ctx.body.exit).toBe(true);
    const sent = await http()
      .post(`/public/reviews/${exit.token}`)
      .send({ npsScore: 3, comment: 'Me sube mucho la cuota', exitReason: 'price' })
      .expect(201);
    expect(sent.body.referral ?? null).toBeNull();
    let task: { title: string; priority: string; metadata: unknown } | null = null;
    for (let i = 0; i < 30 && !task; i++) {
      await sleep(200);
      task = await db.task.findFirst({
        where: { tenantId: tenant.id, metadata: { path: ['autoRule'], equals: 'low_review' } },
      });
    }
    expect(task?.title).toContain('valoración de 3 sobre 10');
    expect(task?.priority).toBe('high');
    expect(task?.metadata).toMatchObject({ reviewId: exit.id, customerId });

    const reasons = await http().get('/analytics/exit-reasons?months=3').set(auth).expect(200);
    expect(reasons.body).toMatchObject({ sent: 1, answered: 1, nps: -100 });
    expect(reasons.body.reasons).toEqual([
      { reason: 'price', label: 'El precio', count: 1, pct: 100 },
    ]);
    const listed = await http().get('/reviews?status=submitted').set(auth);
    expect(listed.body.items[0]).toMatchObject({ exit: true, exitReason: 'price' });

    // Un promotor recibe su código para recomendar.
    const happy = await newReview('reviews.manual');
    expect((await http().get(`/public/reviews/${happy.token}`)).body.exit).toBe(false);
    const promoter = await http()
      .post(`/public/reviews/${happy.token}`)
      .send({ npsScore: 10, rating: 5, exitReason: 'price' })
      .expect(201);
    expect(promoter.body.referral).toMatchObject({ reward: { type: 'fixed', value: 15 } });
    expect(promoter.body.referral.shareUrl).toContain(`?ref=${promoter.body.referral.code}`);
    // El motivo de baja solo se guarda en la encuesta de salida.
    expect((await db.review.findUniqueOrThrow({ where: { id: happy.id } })).exitReason).toBeNull();

    // Cifras por periodo y por local, y NPS mes a mes.
    const stats = await http()
      .get(`/reviews/stats?months=3&facilityId=${fac.facilityId}`)
      .set(auth)
      .expect(200);
    expect(stats.body).toMatchObject({ submitted: 2, promoters: 1, detractors: 1, npsScore: 0 });
    const elsewhere = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const empty = await http().get(`/reviews/stats?facilityId=${elsewhere.facilityId}`).set(auth);
    expect(empty.body.submitted).toBe(0);
    await http().get('/reviews/stats?months=99').set(auth).expect(400);
    const insights = await http().get('/reviews/insights?months=6').set(auth).expect(200);
    expect(insights.body.trend).toHaveLength(6);
    expect(insights.body.trend[5]).toMatchObject({ responses: 2, nps: 0 });
    expect(insights.body.byFacility).toHaveLength(1);
    expect(insights.body.byFacility[0]).toMatchObject({ facilityId: fac.facilityId, responses: 2 });

    // Recordatorio a los 7 días: una vez, y solo si el negocio lo activa.
    const waiting = await newReview('reviews.manual', new Date(Date.now() - 8 * DAY));
    expect((await reviews.sendReminders()).reminded).toBe(0);
    const on = await http()
      .patch('/settings/tenant/reviews')
      .set(auth)
      .send({ reviewsReminderEnabled: true, reviewsYearlyEnabled: true })
      .expect(200);
    expect(on.body).toMatchObject({ reviewsReminderEnabled: true, reviewsYearlyEnabled: true });
    expect((await reviews.sendReminders()).reminded).toBe(1);
    expect((await reviews.sendReminders()).reminded).toBe(0);
    expect(
      (await db.review.findUniqueOrThrow({ where: { id: waiting.id } })).remindedAt,
    ).not.toBeNull();
    const reminder = await db.communication.findFirstOrThrow({
      where: { tenantId: tenant.id, source: 'reviews.manual.reminder' },
    });
    expect(reminder.subject).toContain('Recordatorio');

    // Valoración anual: a quien lleva más de un año y sin ninguna en 12 meses.
    expect((await reviews.requestYearly()).requested).toBe(0);
    await db.review.updateMany({
      where: { tenantId: tenant.id },
      data: { requestedAt: new Date(Date.now() - 400 * DAY) },
    });
    expect((await reviews.requestYearly()).requested).toBe(0);
    await db.contract.update({
      where: { id: contractId },
      data: { signedAt: new Date(Date.now() - 400 * DAY) },
    });
    expect((await reviews.requestYearly()).requested).toBe(1);
    expect((await reviews.requestYearly()).requested).toBe(0);
    const yearly = await db.review.findFirstOrThrow({
      where: { tenantId: tenant.id, source: 'reviews.yearly' },
    });
    expect(yearly.status).toBe('pending');
  }, 120_000);
});
