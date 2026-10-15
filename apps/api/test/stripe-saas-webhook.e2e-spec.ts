import { PrismaClient } from '@storageos/database';
import StripeSDK from 'stripe';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Webhook de Stripe de las suscripciones con la forma de la API actual: la
 * factura ya no trae `subscription` (vive en `parent.subscription_details`).
 */
describe('Webhook de Stripe de la suscripción (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const stripe = new StripeSDK('sk_test_dummy');

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

  function signed(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_dummy',
    });
    return { payload, header };
  }

  it('registra el cobro fallido de la cuota aunque la factura no traiga subscription', async () => {
    const owner = await registerVerifiedUser(app, 'stripewh');
    const stamp = Date.now();
    const cus = `cus_wh_${stamp}`;
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { stripeCustomerId: cus },
    });
    const invoiceId = `in_wh_${stamp}`;
    const { payload, header } = signed({
      id: `evt_wh_${stamp}`,
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: invoiceId,
          object: 'invoice',
          customer: cus,
          amount_due: 9559,
          total: 9559,
          currency: 'eur',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: `sub_wh_${stamp}` },
          },
          lines: { data: [{ period: { start: 1760000000, end: 1762600000 } }] },
        },
      },
    });
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('stripe-signature', header)
      .set('content-type', 'application/json')
      .send(payload)
      .expect(200);

    const row = await admin.tenantSubscriptionPayment.findFirst({
      where: { provider: 'stripe', externalId: invoiceId },
    });
    expect(row).toMatchObject({ tenantId: owner.tenantId, status: 'failed', failedAttempts: 1 });
    expect(Number(row!.amount)).toBe(95.59);
  });
});
