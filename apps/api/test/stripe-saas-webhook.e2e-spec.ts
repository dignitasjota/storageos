import { PrismaClient } from '@storageos/database';
import StripeSDK from 'stripe';
import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';

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

  function subscriptionEvent(type: string, sub: Record<string, unknown>) {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return signed({
      id: `evt_sub_${stamp}`,
      object: 'event',
      type,
      data: { object: { object: 'subscription', ...sub } },
    });
  }

  async function sendEvent(e: { payload: string; header: string }) {
    await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('stripe-signature', e.header)
      .set('content-type', 'application/json')
      .send(e.payload)
      .expect(200);
  }

  it('un cambio de plan no se deshace con el siguiente subscription.updated', async () => {
    const owner = await registerVerifiedUser(app, 'stripewhplan');
    const stamp = Date.now();
    const subId = `sub_plan_${stamp}`;
    const cus = `cus_plan_${stamp}`;
    const [starter, pro] = await Promise.all([
      admin.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } }),
      admin.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'pro' } }),
    ]);
    const nowSec = Math.floor(Date.now() / 1000);
    const base = {
      id: subId,
      customer: cus,
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [{ current_period_start: nowSec, current_period_end: nowSec + 30 * 86400 }],
      },
      // Metadatos del Checkout: el plan con el que se suscribió.
      metadata: { tenantId: owner.tenantId, planId: starter.id },
    };

    // Suscripción nueva (Checkout): el plan de los metadatos se aplica.
    await sendEvent(subscriptionEvent('customer.subscription.created', base));
    let sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub.planId).toBe(starter.id);
    expect(sub.stripeSubscriptionId).toBe(subId);

    // El tenant (o el admin) cambia a pro; Stripe avisa con los metadatos viejos.
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { planId: pro.id },
    });
    await sendEvent(subscriptionEvent('customer.subscription.updated', base));
    sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub.planId).toBe(pro.id);
  });

  it('pasar a pago manual no se deshace con el aviso de la cancelación en Stripe', async () => {
    const owner = await registerVerifiedUser(app, 'stripewhmode');
    const stamp = Date.now();
    const subId = `sub_mode_${stamp}`;
    const nowSec = Math.floor(Date.now() / 1000);
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        stripeSubscriptionId: subId,
        stripeCustomerId: `cus_mode_${stamp}`,
        billingMode: 'stripe',
        status: 'active',
      },
    });
    // Lo que hace «Pasar a pago manual» (la cancelación en Stripe es best-effort).
    const billing = app.get(BillingSaasService, { strict: false });
    await billing.setBillingMode(owner.tenantId, 'manual');

    // Stripe avisa de la suscripción cancelada (con el tenant en sus metadatos).
    await sendEvent(
      subscriptionEvent('customer.subscription.deleted', {
        id: subId,
        customer: `cus_mode_${stamp}`,
        status: 'canceled',
        cancel_at_period_end: false,
        items: { data: [{ current_period_start: nowSec, current_period_end: nowSec + 86400 }] },
        metadata: { tenantId: owner.tenantId },
      }),
    );
    const sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub).toMatchObject({
      billingMode: 'manual',
      stripeSubscriptionId: null,
      status: 'active',
    });
  });

  it('la cancelación de la suscripción vigente sí se aplica', async () => {
    const owner = await registerVerifiedUser(app, 'stripewhcancel');
    const stamp = Date.now();
    const subId = `sub_cancel_${stamp}`;
    const nowSec = Math.floor(Date.now() / 1000);
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { stripeSubscriptionId: subId, billingMode: 'stripe', status: 'active' },
    });
    await sendEvent(
      subscriptionEvent('customer.subscription.deleted', {
        id: subId,
        customer: `cus_cancel_${stamp}`,
        status: 'canceled',
        cancel_at_period_end: false,
        items: { data: [{ current_period_start: nowSec, current_period_end: nowSec + 86400 }] },
        metadata: { tenantId: owner.tenantId },
      }),
    );
    const sub = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub.status).toBe('cancelled');
  });
});
