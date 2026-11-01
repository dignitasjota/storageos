import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? '';

/** Revisión de «Catálogo y precios» del panel admin (PR A). */
describe('Catálogo y precios: revisión (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  const SLUG = `e2e-cat-${Date.now()}`;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    const admin = await seedSuperAdmin('catrev');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await db.subscriptionAddon.deleteMany({ where: { slug: { startsWith: 'e2e-cat-' } } });
    await db.platformCoupon.deleteMany({ where: { code: { startsWith: 'E2ECAT' } } });
    await cleanupTestTenants();
    await db.subscriptionPlan.deleteMany({ where: { slug: { startsWith: 'e2e-cat-' } } });
    await cleanupSuperAdmins();
    await db.$disconnect();
  });

  it('un plan nuevo sin funciones marcadas no da funciones premium', async () => {
    const created = await request(app.getHttpServer())
      .post('/subscription-plans')
      .set(auth)
      .send({ slug: SLUG, name: 'Básico', priceMonthly: 29, priceYearly: 0 });
    expect(created.status).toBe(201);

    const owner = await registerVerifiedUser(app, 'catrevplan');
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    await db.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { planId: created.body.id },
    });
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(me.body.features).toEqual([]);

    // Simulador anual con un plan sin precio anual: 12 cuotas.
    const quote = await request(app.getHttpServer())
      .post('/admin/quote')
      .set(auth)
      .send({ planId: created.body.id, cycle: 'yearly' });
    expect(quote.status).toBe(200);
    expect(quote.body.lines[0].amount).toBe(348);
    expect(quote.body.yearlySaving).toBe(0);

    // Slug repetido.
    const dup = await request(app.getHttpServer())
      .post('/subscription-plans')
      .set(auth)
      .send({ slug: SLUG, name: 'Otro', priceMonthly: 1, priceYearly: 0 });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('slug_taken');
  });

  it('los planes de los que depende la aplicación no se desactivan ni se renombran', async () => {
    const plans = await request(app.getHttpServer()).get('/subscription-plans/admin').set(auth);
    const starter = plans.body.find((p: { slug: string }) => p.slug === 'starter');
    const free = plans.body.find((p: { slug: string }) => p.slug === 'free');
    const pro = plans.body.find((p: { slug: string }) => p.slug === 'pro');

    const del = await request(app.getHttpServer())
      .delete(`/subscription-plans/${starter.id}`)
      .set(auth);
    expect(del.status).toBe(400);
    expect(del.body.code).toBe('plan_required');

    const off = await request(app.getHttpServer())
      .patch(`/subscription-plans/${free.id}`)
      .set(auth)
      .send({ isActive: false });
    expect(off.status).toBe(400);
    expect(off.body.code).toBe('plan_required');

    const rename = await request(app.getHttpServer())
      .patch(`/subscription-plans/${pro.id}`)
      .set(auth)
      .send({ slug: 'pro-nuevo' });
    expect(rename.status).toBe(400);
    expect(rename.body.code).toBe('plan_slug_locked');
  });

  it('un cupón porcentual no puede pasar del 100 %', async () => {
    const bad = await request(app.getHttpServer())
      .post('/admin/coupons')
      .set(auth)
      .send({ code: 'E2ECAT150', discountType: 'percentage', discountValue: 150 });
    expect(bad.status).toBe(400);

    const fixed = await request(app.getHttpServer())
      .post('/admin/coupons')
      .set(auth)
      .send({ code: 'E2ECATFIX', discountType: 'fixed', discountValue: 150 });
    expect(fixed.status).toBe(201);
    const toPct = await request(app.getHttpServer())
      .patch(`/admin/coupons/${fixed.body.id}`)
      .set(auth)
      .send({ discountType: 'percentage' });
    expect(toPct.status).toBe(400);
    expect(toPct.body.code).toBe('coupon_percentage_too_high');
  });

  it('un extra desactivado no se contrata ni se prueba de nuevo', async () => {
    const owner = await registerVerifiedUser(app, 'catrevaddon');
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const addon = await request(app.getHttpServer())
      .post('/admin/addons')
      .set(auth)
      .send({
        slug: `${SLUG}-a`,
        name: 'Extra retirado',
        priceMonthly: 10,
        feature: 'cameras',
        isActive: false,
      });
    expect(addon.status).toBe(201);

    const assign = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addons`)
      .set(auth)
      .send({ addonId: addon.body.id, quantity: 1 });
    expect(assign.status).toBe(400);
    expect(assign.body.code).toBe('addon_not_available');

    const trial = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenant.id}/addon-trials/${addon.body.id}`)
      .set(auth)
      .send({ days: 7 });
    expect(trial.status).toBe(400);
    expect(trial.body.code).toBe('addon_not_available');
  });
});
