import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import {
  BASIC_USER_ADDON_SLUG,
  DEFAULT_SAAS_ADDONS,
  EXTRA_UNITS_ADDON_SLUG,
} from '@storageos/shared';
import request from 'supertest';

import { SaasAddonsService } from '../src/modules/billing-saas/saas-addons.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { TenantSelfAddonsDto } from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-basic-test@storageos.local';

/**
 * Plan Basic: 1 € por trastero con un mínimo de 19 €, hasta 50 trasteros, un
 * local y un usuario (el segundo, con su extra). Los trasteros que pasan de los
 * 19 incluidos se cobran con el extra interno «Trasteros de más».
 */
describe('Plan Basic (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let adminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    // Como el arranque de producción: el plan y sus extras.
    await db.subscriptionPlan.upsert({
      where: { slug: 'basic' },
      update: { includedUnits: 19, maxUnits: 50, maxFacilities: 1, maxUsers: 1 },
      create: {
        name: 'Basic',
        slug: 'basic',
        priceMonthly: 19,
        priceYearly: 0,
        maxUnits: 50,
        maxFacilities: 1,
        maxUsers: 1,
        includedUnits: 19,
        features: {},
        tenantFeatures: [],
      },
    });
    for (const a of DEFAULT_SAAS_ADDONS) {
      const data = {
        name: a.name,
        priceMonthly: a.priceMonthly,
        feature: a.feature,
        grantsUsers: a.grantsUsers ?? null,
        planSlugs: a.planSlugs ?? [],
        maxQuantity: a.maxQuantity ?? null,
        isSystem: a.isSystem ?? false,
      };
      await db.subscriptionAddon.upsert({
        where: { slug: a.slug },
        update: {
          planSlugs: data.planSlugs,
          maxQuantity: data.maxQuantity,
          isSystem: data.isSystem,
        },
        create: { slug: a.slug, ...data },
      });
    }
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Basic Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${adminToken}` });

  it('cobra los trasteros de más antes de cada cobro y limita extras y trasteros', async () => {
    const owner = await registerVerifiedUser(app, 'basic-plan');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'basic');
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 25 });
    const addons = app.get(SaasAddonsService);

    // Se cuentan los de ahora: 6 de más (25 − 19), sin cobro aparte.
    expect(await addons.syncAllExtraUnits()).toBeGreaterThanOrEqual(1);
    let view = (await http().get('/settings/saas-billing/addons').set(auth).expect(200))
      .body as TenantSelfAddonsDto;
    const extra = view.summary.addons.find((a) => a.slug === EXTRA_UNITS_ADDON_SLUG);
    expect(extra).toMatchObject({ quantity: 6, isSystem: true, billingMode: 'manual' });
    expect(view.summary.effectiveMonthly).toBe(25);
    const before = await db.tenantSubscriptionAddon.findFirstOrThrow({
      where: { tenantId: tenant.id, addon: { slug: EXTRA_UNITS_ADDON_SLUG } },
    });
    // Nunca sale en «Hoy» como cobro aparte.
    expect(before.nextChargeAt).toBeNull();
    // Sin cambios, no hay nada que hacer.
    expect(await addons.syncExtraUnits(tenant.id)).toBe(false);

    // En el autoservicio: ni el extra interno ni lo que no es de su plan.
    expect(view.available.some((a) => a.slug === EXTRA_UNITS_ADDON_SLUG)).toBe(false);
    // La domiciliación SEPA sí se puede contratar aparte en Basic.
    expect(view.available.some((a) => a.slug === 'addon-sepa')).toBe(true);
    const second = view.available.find((a) => a.slug === BASIC_USER_ADDON_SLUG);
    expect(second).toBeDefined();
    await http()
      .delete(`/settings/saas-billing/addons/${before.id}`)
      .set(auth)
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('addon_managed_by_platform'));
    await http()
      .post('/settings/saas-billing/addons')
      .set(auth)
      .send({ addonId: second!.id, quantity: 2 })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('addon_max_quantity'));
    view = (
      await http()
        .post('/settings/saas-billing/addons')
        .set(auth)
        .send({ addonId: second!.id, quantity: 1 })
        .expect(200)
    ).body as TenantSelfAddonsDto;
    expect(view.summary.effectiveMonthly).toBe(35);

    // Un segundo local no cabe en Basic, y el mensaje lo dice.
    const facility = await http()
      .post('/facilities')
      .set(auth)
      .send({ name: 'Otro', city: 'Madrid', country: 'ES', timezone: 'Europe/Madrid' })
      .expect(403);
    expect(facility.body.message).toContain('Basic');

    // Pasar a Starter quita los extras que ya no hacen falta y avisa.
    await http()
      .post(`/admin/tenants/${tenant.id}/change-plan`)
      .set(admin())
      .send({ planSlug: 'starter', reason: 'Crece' })
      .expect(200);
    const left = await db.tenantSubscriptionAddon.findMany({ where: { tenantId: tenant.id } });
    expect(left).toHaveLength(0);
    const notice = await db.notification.findFirst({
      where: { tenantId: tenant.id, type: 'billing.addons_removed' },
    });
    expect(notice?.body).toContain('Segundo usuario');

    // En Starter el segundo usuario de Basic no se vende.
    await http()
      .post('/settings/saas-billing/addons')
      .set(auth)
      .send({ addonId: second!.id, quantity: 1 })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('addon_not_for_plan'));
  });

  it('no deja bajar a Basic sin caber y el simulador cuenta los trasteros de más', async () => {
    const owner = await registerVerifiedUser(app, 'basic-down');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    await http()
      .post('/facilities')
      .set(auth)
      .send({ name: 'Segundo', city: 'Madrid', country: 'ES', timezone: 'Europe/Madrid' })
      .expect(201);
    // Con suscripción en Stripe: se comprueba antes de tocar Stripe.
    await db.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: { stripeSubscriptionId: `sub_e2e_${Date.now()}` },
    });
    const basic = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'basic' } });
    const res = await http()
      .post('/settings/saas-billing/change-plan')
      .set(auth)
      .send({ planId: basic.id })
      .expect(400);
    expect(res.body.code).toBe('plan_limits_exceeded');
    expect(res.body.message).toContain('2 locales');
    await http()
      .post('/settings/saas-billing/change-plan')
      .set(auth)
      .send({ planId: basic.id, billingCycle: 'yearly' })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('yearly_not_available'));

    const quote = await http()
      .post('/admin/quote')
      .set(admin())
      .send({ planId: basic.id, units: 30 })
      .expect(200);
    expect(quote.body.lines.map((l: { label: string }) => l.label)).toEqual([
      'Plan Basic',
      'Trasteros de más (11 × 1 €)',
    ]);
    expect(quote.body.subtotal).toBe(30);

    // Pro anuncia sus trasteros incluidos (ninguno: precio fijo) y Basic su precio por trastero.
    const plans = (await http().get('/subscription-plans').expect(200)).body as {
      slug: string;
      includedUnits: number | null;
      extraUnitPrice: number | null;
    }[];
    expect(plans.find((p) => p.slug === 'basic')).toMatchObject({
      includedUnits: 19,
      extraUnitPrice: 1,
    });
    expect(plans.some((p) => p.slug === 'free')).toBe(false);
  });
  it('al llegar al tope de Administrador, avisa para darle un precio a medida (una vez)', async () => {
    const owner = await registerVerifiedUser(app, 'admin-cap');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'administrador');
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    // Tope bajo solo para la prueba (de verdad, 1.500).
    await db.subscriptionPlan.update({ where: { slug: 'administrador' }, data: { maxUnits: 1 } });
    try {
      const unit = (code: string) =>
        http().post('/units').set(auth).send({
          facilityId,
          unitTypeId,
          code,
          widthM: 2,
          depthM: 2,
          heightM: 2.5,
          basePriceMonthly: 50,
        });
      const res = await unit('CAP-2').expect(403);
      expect(res.body.code).toBe('units_limit_reached');
      expect(res.body.message).toContain('precio a medida');
      await unit('CAP-3').expect(403);
      const followups = await db.tenantFollowup.findMany({
        where: { tenantId: tenant.id, status: 'pending', title: { startsWith: 'Precio a medida' } },
      });
      expect(followups).toHaveLength(1);
      expect(
        await db.superAdminNotification.count({
          where: { type: 'tenant.custom_pricing', link: `/admin/tenants/${tenant.id}` },
        }),
      ).toBe(1);
    } finally {
      await db.subscriptionPlan.update({
        where: { slug: 'administrador' },
        data: { maxUnits: 1500 },
      });
    }
  });
});
