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
 * `planManual` de billing-status: un plan impagado sin Stripe se regulariza por
 * soporte (el banner muestra «He realizado el pago» en vez del portal online).
 */
describe('Estado de pago del plan (e2e)', () => {
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

  it('marca planManual cuando el plan past_due no tiene Stripe', async () => {
    const owner = await registerVerifiedUser(app, 'bill-status');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Plan impagado sin suscripción Stripe → manual.
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'past_due', stripeSubscriptionId: null },
    });
    const manual = await request(app.getHttpServer()).get('/settings/billing-status').set(auth);
    expect(manual.status).toBe(200);
    expect(manual.body.pastDue).toBe(true);
    expect(manual.body.planManual).toBe(true);
    expect(manual.body.hasIssue).toBe(true);

    // Con suscripción Stripe → no es manual (se paga por el portal).
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { stripeSubscriptionId: 'sub_bill_status' },
    });
    const stripe = await request(app.getHttpServer()).get('/settings/billing-status').set(auth);
    expect(stripe.body.pastDue).toBe(true);
    expect(stripe.body.planManual).toBe(false);
  });

  it('sin sesión → 401', async () => {
    await request(app.getHttpServer()).get('/settings/billing-status').expect(401);
  });
});
