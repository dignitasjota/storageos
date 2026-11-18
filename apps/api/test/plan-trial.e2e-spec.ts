import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { TenantLifecycleEmailsService } from '../src/modules/admin/tenant-lifecycle-emails.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * La prueba empieza con el plan elegido al registrarse (con sus límites) y el
 * plan gratuito pasa a Basic con 30 días de aviso; sin pagar, la cuenta queda
 * en solo lectura.
 */
describe('Prueba con plan elegido y fin del plan gratuito (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.subscriptionPlan.upsert({
      where: { slug: 'basic' },
      update: { includedUnits: 19, maxUnits: 50, maxFacilities: 1, maxUsers: 1, isPublic: true },
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
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  it('se registra con el plan elegido y sus límites valen desde la prueba', async () => {
    const stamp = Date.now().toString(36);
    const res = await http()
      .post('/auth/register')
      .send({
        tenantName: `Basic ${stamp}`,
        fullName: 'Ana Prueba',
        email: `basic-${stamp}@e2e.local`,
        password: 'Prueba!2345',
        acceptTerms: true,
        planSlug: 'basic',
      })
      .expect(201);
    expect(res.body.subscription.planSlug).toBe('basic');
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: res.body.tenant.id as string },
      include: { subscription: { include: { plan: true } } },
    });
    expect(tenant.status).toBe('trial');
    expect(tenant.subscription?.plan.slug).toBe('basic');
    expect(tenant.subscription?.status).toBe('trial');

    // Un plan que no se ofrece cae en el de siempre.
    await http()
      .post('/auth/register')
      .send({
        tenantName: `Libre ${stamp}`,
        fullName: 'Luis Prueba',
        email: `free-${stamp}@e2e.local`,
        password: 'Prueba!2345',
        acceptTerms: true,
        planSlug: 'free',
      })
      .expect(400);
  });

  it('avisa con 30 días a quien tiene el plan gratuito y ese día pasa a Basic en solo lectura', async () => {
    const owner = await registerVerifiedUser(app, 'free-plan');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'free');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'active' },
    });
    const lifecycle = app.get(TenantLifecycleEmailsService);

    // Primer paso: el aviso, una sola vez.
    await lifecycle.runFreePlanTransition();
    let tenant = await db.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } });
    expect(tenant.freePlanEndsAt).not.toBeNull();
    const days = (tenant.freePlanEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'billing.free_plan_ending' },
      }),
    ).toBe(1);
    await lifecycle.runFreePlanTransition();
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'billing.free_plan_ending' },
      }),
    ).toBe(1);
    // Mientras tanto sigue trabajando.
    await http()
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local', city: 'Madrid', country: 'ES', timezone: 'Europe/Madrid' })
      .expect(201);

    // Llega el día: pasa a Basic y, sin pagar, a solo lectura.
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { freePlanEndsAt: new Date(Date.now() - 60_000) },
    });
    await lifecycle.runFreePlanTransition();
    tenant = await db.tenant.findUniqueOrThrow({
      where: { id: owner.tenantId },
      include: { subscription: { include: { plan: true } } },
    });
    expect(tenant.subscription?.plan.slug).toBe('basic');
    expect(tenant.subscription?.status).toBe('expired');
    expect(tenant.freePlanEndsAt).toBeNull();
    const blocked = await http()
      .post('/facilities')
      .set(auth)
      .send({ name: 'Otro', city: 'Madrid', country: 'ES', timezone: 'Europe/Madrid' })
      .expect(403);
    expect(blocked.body.code).toBe('subscription_expired_read_only');
    // Puede consultar y pagar.
    await http().get('/facilities').set(auth).expect(200);
    await http().get('/settings/saas-billing').set(auth).expect(200);
  });
});
