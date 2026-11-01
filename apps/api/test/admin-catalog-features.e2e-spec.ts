import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? '';

/** Mejoras de «Catálogo y precios» del panel admin (PR B). */
describe('Catálogo y precios: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  const SLUG = `e2e-catf-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    const admin = await seedSuperAdmin('catfeat');
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await db.platformCoupon.deleteMany({ where: { code: { startsWith: 'E2ECATF' } } });
    await db.subscriptionAddon.deleteMany({ where: { slug: { startsWith: 'e2e-catf-' } } });
    await cleanupTestTenants();
    const plans = await db.subscriptionPlan.findMany({
      where: { slug: { startsWith: 'e2e-catf-' } },
      select: { id: true },
    });
    await db.catalogPriceHistory.deleteMany({
      where: { itemId: { in: plans.map((p) => p.id) } },
    });
    await db.subscriptionPlan.deleteMany({ where: { slug: { startsWith: 'e2e-catf-' } } });
    await cleanupSuperAdmins();
    await db.$disconnect();
  });

  async function newPlan(suffix: string, body: Record<string, unknown> = {}) {
    const res = await http()
      .post('/subscription-plans')
      .set(auth)
      .send({
        slug: `${SLUG}-${suffix}`,
        name: `Plan ${suffix}`,
        priceMonthly: 50,
        priceYearly: 500,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  it('planes: tenants y MRR, vista previa de precio, histórico, no se desactiva con tenants y ocultos', async () => {
    const plan = await newPlan('p');
    const owner = await registerVerifiedUser(app, 'catfplan');
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { planId: plan.id, status: 'active' },
    });
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });

    const list = await http().get('/subscription-plans/admin').set(auth).expect(200);
    const row = list.body.find((p: { id: string }) => p.id === plan.id);
    expect(row).toMatchObject({ tenantCount: 1, payingTenants: 1, mrr: 50, isPublic: true });

    const preview = await http()
      .get(`/subscription-plans/admin/${plan.id}/price-preview?priceMonthly=60`)
      .set(auth)
      .expect(200);
    expect(preview.body).toMatchObject({
      tenants: 1,
      payingTenants: 1,
      currentMrr: 50,
      newMrr: 60,
      delta: 10,
    });

    await http()
      .patch(`/subscription-plans/${plan.id}`)
      .set(auth)
      .send({ priceMonthly: 60 })
      .expect(200);
    const history = await http()
      .get(`/admin/catalog/price-history?kind=plan&itemId=${plan.id}`)
      .set(auth)
      .expect(200);
    expect(history.body[0]).toMatchObject({ oldPriceMonthly: 50, newPriceMonthly: 60 });

    const off = await http().delete(`/subscription-plans/${plan.id}`).set(auth);
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('plan_in_use');

    // Plan oculto: no sale en la web ni en el autoservicio, pero se asigna.
    const hidden = await newPlan('h', { isPublic: false, stripePriceId: 'price_e2e_hidden' });
    const pub = await http().get('/subscription-plans').expect(200);
    expect(pub.body.some((p: { id: string }) => p.id === hidden.id)).toBe(false);
    const other = await registerVerifiedUser(app, 'catfhid');
    const checkout = await http()
      .post('/settings/saas-billing/checkout')
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .send({
        planId: hidden.id,
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/ko',
      });
    expect(checkout.status).toBe(400);
    expect(checkout.body.code).toBe('plan_not_available');
  });

  it('extras: precio por tramos al asignar, tenants que lo tienen e histórico', async () => {
    const owner = await registerVerifiedUser(app, 'catfaddon');
    const addon = await http()
      .post('/admin/addons')
      .set(auth)
      .send({
        slug: `${SLUG}-a`,
        name: 'Usuarios extra',
        priceMonthly: 5,
        priceTiers: [
          { minQuantity: 5, unitPrice: 4 },
          { minQuantity: 10, unitPrice: 3 },
        ],
        isActive: true,
      });
    expect(addon.status).toBe(201);
    expect(addon.body.priceTiers).toHaveLength(2);

    const summary = await http()
      .post(`/admin/tenants/${owner.tenantId}/addons`)
      .set(auth)
      .send({ addonId: addon.body.id, quantity: 6 });
    expect(summary.status).toBe(201);
    const line = summary.body.addons.find((a: { addonId: string }) => a.addonId === addon.body.id);
    expect(line).toMatchObject({ priceMonthly: 4, quantity: 6, lineTotal: 24 });

    const catalog = await http().get('/admin/addons').set(auth).expect(200);
    expect(catalog.body.find((a: { id: string }) => a.id === addon.body.id).tenantCount).toBe(1);

    const quote = await http()
      .post('/admin/quote')
      .set(auth)
      .send({
        planId: (await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } })).id,
        addons: [{ addonId: addon.body.id, quantity: 12 }],
      })
      .expect(200);
    expect(quote.body.lines[1].amount).toBe(36);

    await http()
      .patch(`/admin/addons/${addon.body.id}`)
      .set(auth)
      .send({ slug: `${SLUG}-a`, name: 'Usuarios extra', priceMonthly: 6, isActive: true })
      .expect(200);
    const history = await http()
      .get(`/admin/catalog/price-history?kind=addon&itemId=${addon.body.id}`)
      .set(auth)
      .expect(200);
    expect(history.body[0]).toMatchObject({ oldPriceMonthly: 5, newPriceMonthly: 6 });
  });

  it('cupones: condiciones, usos, borrado y aviso si no está en Stripe', async () => {
    const plan = await newPlan('c', { stripePriceId: 'price_e2e_coupon' });
    const starter = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    const coupon = await http()
      .post('/admin/coupons')
      .set(auth)
      .send({
        code: 'E2ECATFONE',
        discountType: 'percentage',
        discountValue: 20,
        planIds: [starter.id],
        oncePerTenant: true,
      });
    expect(coupon.status).toBe(201);
    expect(coupon.body).toMatchObject({ oncePerTenant: true, stripeReady: false });

    // Solo para el plan starter.
    const other = await http()
      .post('/admin/quote')
      .set(auth)
      .send({ planId: plan.id, couponCode: 'E2ECATFONE' })
      .expect(200);
    expect(other.body.couponError).toMatch(/plan/);

    // Un uso por tenant.
    const owner = await registerVerifiedUser(app, 'catfcoupon');
    const pay = () =>
      http().post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`).set(auth).send({
        provider: 'bank_transfer',
        amount: 100,
        durationMonths: 1,
        couponCode: 'E2ECATFONE',
      });
    expect((await pay()).status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    const again = await http()
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'cash', amount: 100, durationMonths: 1, couponCode: 'E2ECATFONE' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('coupon_already_used');

    const uses = await http()
      .get(`/admin/coupons/${coupon.body.id}/redemptions`)
      .set(auth)
      .expect(200);
    expect(uses.body).toMatchObject({ totalDiscount: 20, tenants: 1 });
    expect(uses.body.items[0]).toMatchObject({ source: 'manual', discount: 20 });

    // Con usos no se borra; sin usos sí.
    expect((await http().delete(`/admin/coupons/${coupon.body.id}`).set(auth)).status).toBe(409);
    const unused = await http()
      .post('/admin/coupons')
      .set(auth)
      .send({ code: 'E2ECATFDEL', discountType: 'fixed', discountValue: 5 });
    await http().delete(`/admin/coupons/${unused.body.id}`).set(auth).expect(204);

    // Todavía no válido.
    const future = await http()
      .post('/admin/coupons')
      .set(auth)
      .send({
        code: 'E2ECATFFUT',
        discountType: 'fixed',
        discountValue: 5,
        validFrom: new Date(Date.now() + 86_400_000).toISOString(),
      });
    const q = await http()
      .post('/admin/quote')
      .set(auth)
      .send({ planId: plan.id, couponCode: future.body.code })
      .expect(200);
    expect(q.body.couponError).toMatch(/todavía/);

    // En el Checkout el cupón tiene que existir en Stripe.
    const buyer = await registerVerifiedUser(app, 'catfbuyer');
    const fixed = await http()
      .post('/admin/coupons')
      .set(auth)
      .send({ code: 'E2ECATFSTR', discountType: 'fixed', discountValue: 5 });
    expect(fixed.status).toBe(201);
    const checkout = await http()
      .post('/settings/saas-billing/checkout')
      .set({ Authorization: `Bearer ${buyer.accessToken}` })
      .send({
        planId: plan.id,
        couponCode: 'E2ECATFSTR',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/ko',
      });
    expect(checkout.status).toBe(400);
    expect(checkout.body.code).toBe('coupon_not_in_stripe');
  });

  it('propuestas: se guardan con su enlace, se aceptan al cambiar de plan y se rechazan a mano', async () => {
    const owner = await registerVerifiedUser(app, 'catfoffer');
    const pro = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'pro' } });
    const sent = await http()
      .post(`/admin/tenants/${owner.tenantId}/quote-offers`)
      .set(auth)
      .send({ planId: pro.id, cycle: 'yearly', followupDays: 0 })
      .expect(201);
    expect(sent.body.offerId).toBeTruthy();

    const list = await http()
      .get(`/admin/quote-offers?tenantId=${owner.tenantId}`)
      .set(auth)
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ status: 'sent', cycle: 'yearly', planId: pro.id });
    expect(list.body.items[0].acceptUrl).toContain(`plan=${pro.id}`);
    expect(list.body.items[0].acceptUrl).toContain('cycle=yearly');

    await http()
      .post(`/admin/tenants/${owner.tenantId}/change-plan`)
      .set(auth)
      .send({ planSlug: 'pro', reason: 'acepta la propuesta' });
    const after = await http()
      .get(`/admin/quote-offers?tenantId=${owner.tenantId}`)
      .set(auth)
      .expect(200);
    expect(after.body.items[0].status).toBe('accepted');
    expect(after.body.stats).toMatchObject({ sent: 1, accepted: 1, conversionPct: 100 });

    const rejected = await http()
      .patch(`/admin/quote-offers/${sent.body.offerId}`)
      .set(auth)
      .send({ status: 'rejected' })
      .expect(200);
    expect(rejected.body.status).toBe('rejected');
  });

  it('comisión propia de un tenant y lo cobrado en comisiones', async () => {
    const owner = await registerVerifiedUser(app, 'catffee');
    const set = await http()
      .put(`/admin/payment-settings/tenants/${owner.tenantId}`)
      .set(auth)
      .send({ applicationFeePct: 1.5 })
      .expect(200);
    expect(set.body.find((t: { tenantId: string }) => t.tenantId === owner.tenantId)).toMatchObject(
      {
        applicationFeePct: 1.5,
      },
    );
    const status = await http()
      .get('/settings/stripe-connect')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    expect(status.body.applicationFeePct).toBe(1.5);

    await db.payment.create({
      data: {
        tenantId: owner.tenantId,
        amount: 100,
        status: 'succeeded',
        methodType: 'card',
        gateway: 'stripe',
        applicationFeeAmount: 1.5,
        paidAt: new Date(),
      },
    });
    const report = await http()
      .get('/admin/payment-settings/fee-report?months=3')
      .set(auth)
      .expect(200);
    expect(report.body.months).toHaveLength(3);
    expect(report.body.total).toBeGreaterThanOrEqual(1.5);
    expect(
      report.body.topTenants.some((t: { tenantId: string }) => t.tenantId === owner.tenantId),
    ).toBe(true);

    await http()
      .put(`/admin/payment-settings/tenants/${owner.tenantId}`)
      .set(auth)
      .send({ applicationFeePct: null })
      .expect(200);
    const back = await http()
      .get('/settings/stripe-connect')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    expect(back.body.applicationFeePct).toBe(2);
  });
});
