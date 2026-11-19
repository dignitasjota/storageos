import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import { DEFAULT_SAAS_ADDONS, EXTRA_UNITS_ADDON_SLUG } from '@storageos/shared';
import request from 'supertest';

import { TenantLifecycleEmailsService } from '../src/modules/admin/tenant-lifecycle-emails.service';
import { SaasAddonsService } from '../src/modules/billing-saas/saas-addons.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { AdminTenantAccountDto } from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-plan-review@storageos.local';
const REDSYS_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const DAY = 86_400_000;

/**
 * Revisión de los planes nuevos: los trasteros de más de Basic se cobran con la
 * cuota por cada vía, y el solo lectura tiene salida (pago desde hoy, reducir
 * usuarios, pagar su plan aunque no quepa) y se suspende a los 30 días.
 */
describe('Revisión de los planes (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let adminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.subscriptionPlan.upsert({
      where: { slug: 'basic' },
      update: { includedUnits: 19, maxUnits: 50, maxFacilities: 1, maxUsers: 1, isActive: true },
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
    for (const a of DEFAULT_SAAS_ADDONS.filter((x) => x.isSystem || x.planSlugs)) {
      await db.subscriptionAddon.upsert({
        where: { slug: a.slug },
        update: { isSystem: a.isSystem ?? false, planSlugs: a.planSlugs ?? [] },
        create: {
          slug: a.slug,
          name: a.name,
          priceMonthly: a.priceMonthly,
          feature: a.feature,
          grantsUsers: a.grantsUsers ?? null,
          planSlugs: a.planSlugs ?? [],
          maxQuantity: a.maxQuantity ?? null,
          isSystem: a.isSystem ?? false,
        },
      });
    }
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Plan Review',
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
    await db.platformRedsysSettings.deleteMany({});
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${adminToken}` });

  /** Tenant en Basic, activo y pagando a mano, con `units` trasteros. */
  async function basicTenant(suffix: string, units: number) {
    const owner = await registerVerifiedUser(app, suffix);
    await setTenantPlan(owner.slug, 'basic');
    const tenant = await db.tenant.update({
      where: { slug: owner.slug },
      data: { status: 'active', trialEndsAt: null },
    });
    await db.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: {
        status: 'active',
        billingMode: 'manual',
        currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      },
    });
    const facility = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: units });
    return { owner, tenantId: tenant.id, facility };
  }

  it('los trasteros de más van con la cuota por cada vía y se cuentan al cobrar', async () => {
    const { owner, tenantId, facility } = await basicTenant('plrev-basic', 25);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const addons = app.get(SaasAddonsService);

    // Pago a mano: el cargo de la cuota lleva los 6 de más.
    await addons.syncExtraUnits(tenantId);
    let account = (await http().get(`/admin/tenants/${tenantId}/account`).set(admin()).expect(200))
      .body as AdminTenantAccountDto;
    expect(account.nextCharge?.lines.map((l) => l.label)).toEqual([
      'Plan Basic',
      'Trasteros de más × 6',
    ]);
    expect(account.nextCharge?.total).toBe(25);
    // Nunca como cobro aparte.
    expect(account.addonCharges).toHaveLength(0);

    // Da de alta 3 más: cuentan al cobrar, sin esperar a ningún plazo.
    for (const code of ['X-1', 'X-2', 'X-3']) {
      await http()
        .post('/units')
        .set(auth)
        .send({
          facilityId: facility.facilityId,
          unitTypeId: facility.unitTypeId,
          code,
          widthM: 2,
          depthM: 2,
          heightM: 2.5,
        })
        .expect(201);
    }

    // Redsys: pagando a mano con tarjeta, la cuota más los 9 de más, contados ahora.
    await http()
      .put('/admin/platform-redsys/settings')
      .set(admin())
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: REDSYS_KEY,
        environment: 'test',
        enabled: true,
        bizumEnabled: false,
      })
      .expect(200);
    const options = await http().get('/settings/saas-billing/redsys').set(auth).expect(200);
    expect(options.body.amount).toBe(28);
    // Un plan por trastero no se paga por adelantado: como mucho lo que debe.
    await http()
      .post('/settings/saas-billing/redsys/redirect')
      .set(auth)
      .send({ months: 6 })
      .expect(200);
    const order = await db.platformRedsysOrder.findFirstOrThrow({
      where: { tenantId, status: 'pending' },
    });
    expect(order.months).toBe(1);
    expect(order.amountCents).toBe(2800);

    // El admin no puede quitarlo, suspenderlo ni cobrarlo aparte.
    const row = await db.tenantSubscriptionAddon.findFirstOrThrow({
      where: { tenantId, addon: { slug: EXTRA_UNITS_ADDON_SLUG } },
    });
    expect(row.quantity).toBe(9);
    await http()
      .delete(`/admin/tenants/${tenantId}/addons/${row.id}`)
      .set(admin())
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('addon_managed_by_platform'));
    await http()
      .post(`/admin/tenants/${tenantId}/addons/${row.id}/suspend`)
      .set(admin())
      .expect(400);

    // Los trasteros de un local borrado no se cobran.
    await db.facility.update({
      where: { id: facility.facilityId },
      data: { deletedAt: new Date() },
    });
    await addons.syncExtraUnits(tenantId);
    expect(
      await db.tenantSubscriptionAddon.count({
        where: { tenantId, addon: { slug: EXTRA_UNITS_ADDON_SLUG } },
      }),
    ).toBe(0);
    account = (await http().get(`/admin/tenants/${tenantId}/account`).set(admin()).expect(200))
      .body as AdminTenantAccountDto;
    expect(account.nextCharge?.total).toBe(19);
  });

  it('el simulador no admite Basic anual ni extras de otro plan', async () => {
    const basic = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'basic' } });
    const starter = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    const second = await db.subscriptionAddon.findUniqueOrThrow({
      where: { slug: 'addon-basic-user' },
    });
    await http()
      .post('/admin/quote')
      .set(admin())
      .send({ planId: basic.id, cycle: 'yearly' })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('yearly_not_available'));
    await http()
      .post('/admin/quote')
      .set(admin())
      .send({ planId: starter.id, addons: [{ addonId: second.id, quantity: 1 }] })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('addon_not_for_plan'));
  });

  it('desde el solo lectura: paga desde hoy, puede reducir y a los 30 días se suspende', async () => {
    const owner = await registerVerifiedUser(app, 'plrev-ro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // Una invitación pendiente que luego querrá retirar.
    const invite = await http()
      .post('/invitations')
      .set(auth)
      .send({ email: `plrev-${Date.now()}@e2e.local`, role: 'staff' })
      .expect(201);
    const ended = new Date(Date.now() - 45 * DAY);
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'expired', billingMode: 'manual', currentPeriodEnd: ended },
    });

    // En solo lectura puede retirar la invitación (para caber en un plan menor).
    await http()
      .post(`/invitations/${invite.body.id}/revoke`)
      .set(auth)
      .send({})
      .expect((r) => expect(r.status).toBeLessThan(300));
    // Pero no trabajar.
    await http()
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local', city: 'Madrid', country: 'ES', timezone: 'Europe/Madrid' })
      .expect(403);

    // Paga un mes a mano 45 días después: el mes empieza hoy y queda al día.
    await http()
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set(admin())
      .send({ provider: 'bank_transfer', amount: 79, durationMonths: 1 })
      .expect(201);
    const sub = await db.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);

    // Otra cuenta, 31 días en solo lectura sin pagar: se suspende.
    const other = await registerVerifiedUser(app, 'plrev-susp');
    await db.tenant.update({
      where: { id: other.tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    await db.tenantSubscription.update({
      where: { tenantId: other.tenantId },
      data: { status: 'expired', currentPeriodEnd: new Date(Date.now() - 31 * DAY) },
    });
    await app.get(TenantLifecycleEmailsService).suspendLongReadOnly();
    const t = await db.tenant.findUniqueOrThrow({ where: { id: other.tenantId } });
    expect(t.status).toBe('suspended');
    expect(t.churnReason).toBe('nonpayment');
  });

  it('puede pagar su propio plan aunque no quepa en él', async () => {
    const { owner, tenantId } = await basicTenant('plrev-fit', 3);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // Dos usuarios (propietario + invitación) en un plan de uno.
    await http()
      .post('/invitations')
      .set(auth)
      .send({ email: `plrev-fit-${Date.now()}@e2e.local`, role: 'staff' })
      .expect(403);
    await db.invitation.create({
      data: {
        tenantId,
        email: `plrev-fit2-${Date.now()}@e2e.local`,
        role: 'staff',
        tokenHash: 'x'.repeat(40),
        invitedByUserId: (await db.user.findFirstOrThrow({ where: { tenantId } })).id,
        expiresAt: new Date(Date.now() + 5 * DAY),
      },
    });
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { status: 'expired' },
    });
    const basic = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'basic' } });
    const res = await http().post('/settings/saas-billing/checkout').set(auth).send({
      planId: basic.id,
      billingCycle: 'monthly',
      successUrl: 'http://localhost:3000/ok',
      cancelUrl: 'http://localhost:3000/ko',
    });
    // Sin Stripe de verdad en las pruebas el Checkout falla después, pero no por los límites.
    expect(res.body.code).not.toBe('plan_limits_exceeded');
  });

  it('el plan gratuito ya no se da de alta desde el panel', async () => {
    const res = await http()
      .post('/admin/tenants')
      .set(admin())
      .send({
        tenantName: `Gratis ${Date.now()}`,
        ownerName: 'Ana',
        ownerEmail: `plrev-free-${Date.now()}@e2e.local`,
        planSlug: 'free',
        trialDays: 0,
      });
    expect(res.status).toBe(400);
  });
});
