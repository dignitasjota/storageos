import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Cambio de plan self-service del tenant + guard anti-duplicado del checkout.
 * (El camino Stripe real no se ejercita en e2e; se validan las guardas.)
 */
describe('Cambio de plan self-service (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('valida el cambio de plan y bloquea el checkout duplicado', async () => {
    const owner = await registerVerifiedUser(app, 'plan-change'); // starter, sin Stripe
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const sub = await admin.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    const pro = await admin.subscriptionPlan.findFirst({ where: { slug: 'pro' } });
    const ghostId = '00000000-0000-0000-0000-000000000000';

    // Plan inexistente → 400 plan_not_available.
    const ghost = await request(app.getHttpServer())
      .post('/settings/saas-billing/change-plan')
      .set(auth)
      .send({ planId: ghostId });
    expect(ghost.status).toBe(400);
    expect(ghost.body.code).toBe('plan_not_available');

    // Mismo plan que el actual → 400 already_on_plan.
    const same = await request(app.getHttpServer())
      .post('/settings/saas-billing/change-plan')
      .set(auth)
      .send({ planId: sub!.planId });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('already_on_plan');

    // Cambiar a pro sin suscripción Stripe (pago manual) → 400 manual_plan_change.
    const manual = await request(app.getHttpServer())
      .post('/settings/saas-billing/change-plan')
      .set(auth)
      .send({ planId: pro!.id });
    expect(manual.status).toBe(400);
    expect(manual.body.code).toBe('manual_plan_change');

    // Simulamos que ya tiene una suscripción Stripe activa → el checkout de un
    // plan nuevo se bloquea (evita doble suscripción).
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        stripeSubscriptionId: 'sub_dup_test',
        stripeCustomerId: 'cus_dup_test',
        status: 'active',
      },
    });
    const dup = await request(app.getHttpServer())
      .post('/settings/saas-billing/checkout')
      .set(auth)
      .send({
        planId: pro!.id,
        successUrl: 'https://x.test/ok',
        cancelUrl: 'https://x.test/ko',
      });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('already_subscribed');
  });

  it('sin sesión → 401', async () => {
    await request(app.getHttpServer())
      .post('/settings/saas-billing/change-plan')
      .send({ planId: '00000000-0000-0000-0000-000000000000' })
      .expect(401);
  });
});
