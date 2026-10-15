import { PrismaClient } from '@storageos/database';
import StripeSDK from 'stripe';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Webhook de las cuentas conectadas de Stripe (cobros de los tenants). */
describe('Webhook de Stripe Connect (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const stripe = new StripeSDK('sk_test_dummy');
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? 'whsec_connect_dummy';

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

  function send(event: Record<string, unknown>, key = secret) {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: key });
    return request(app.getHttpServer())
      .post('/webhooks/stripe-connect')
      .set('stripe-signature', header)
      .set('content-type', 'application/json')
      .send(payload);
  }

  it('confirma el cobro, sincroniza la cuenta y olvida una cuenta desautorizada', async () => {
    const owner = await registerVerifiedUser(app, 'connectwh');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const stamp = Date.now();
    const accountId = `acct_stub_wh${stamp}`;
    await admin.tenantStripeAccount.create({
      data: { tenantId: owner.tenantId, stripeAccountId: accountId, chargesEnabled: true },
    });
    await admin.tenant.update({ where: { id: owner.tenantId }, data: { cardProvider: 'stripe' } });

    // Factura emitida con un cobro de Stripe en curso en la cuenta del tenant.
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const intentId = `pi_wh_${stamp}`;
    await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId,
        customerId,
        amount: 121,
        currency: 'EUR',
        status: 'processing',
        methodType: 'card',
        gateway: 'stripe',
        gatewayPaymentId: intentId,
        stripeAccountId: accountId,
        applicationFeeAmount: 2.42,
      },
    });

    // Firma con otro secreto (p. ej. el del webhook de la plataforma) → 400.
    await send({ id: `evt_bad_${stamp}`, type: 'payment_intent.succeeded' }, 'whsec_otro').expect(
      400,
    );

    await send({
      id: `evt_pi_${stamp}`,
      type: 'payment_intent.succeeded',
      account: accountId,
      data: { object: { id: intentId, object: 'payment_intent' } },
    }).expect(200);
    const paid = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(paid.status).toBe('paid');

    // La respuesta de Stripe se perdió (corte de red): el pago quedó fallido y
    // sin el id del cobro. El webhook lo recupera por los metadatos.
    const lostInvoice = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${lostInvoice}/issue`).set(auth).expect(200);
    const lost = await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: lostInvoice,
        customerId,
        amount: 121,
        currency: 'EUR',
        status: 'failed',
        failureReason: 'fetch failed',
        methodType: 'card',
        gateway: 'stripe',
        stripeAccountId: accountId,
      },
    });
    await send({
      id: `evt_lost_${stamp}`,
      type: 'payment_intent.succeeded',
      account: accountId,
      data: {
        object: {
          id: `pi_lost_${stamp}`,
          object: 'payment_intent',
          metadata: { paymentId: lost.id },
        },
      },
    }).expect(200);
    expect((await admin.invoice.findUniqueOrThrow({ where: { id: lostInvoice } })).status).toBe(
      'paid',
    );
    expect(await admin.payment.findUniqueOrThrow({ where: { id: lost.id } })).toMatchObject({
      status: 'succeeded',
      gatewayPaymentId: `pi_lost_${stamp}`,
    });

    // Un evento de otra cuenta no toca nada.
    await send({
      id: `evt_other_${stamp}`,
      type: 'charge.refunded',
      account: 'acct_stub_ajena',
      data: { object: { id: 'ch_x', payment_intent: intentId, amount_refunded: 12100 } },
    }).expect(200);
    expect(
      (await admin.payment.findFirstOrThrow({ where: { gatewayPaymentId: intentId } })).status,
    ).toBe('succeeded');

    // La cuenta deja de poder cobrar (Stripe pide datos).
    await send({
      id: `evt_acc_${stamp}`,
      type: 'account.updated',
      account: accountId,
      data: {
        object: {
          id: accountId,
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: true,
          requirements: {
            currently_due: ['individual.verification.document'],
            disabled_reason: 'requirements.past_due',
          },
        },
      },
    }).expect(200);
    const status = await request(app.getHttpServer()).get('/settings/stripe-connect').set(auth);
    expect(status.body).toMatchObject({
      chargesEnabled: false,
      requirementsDue: ['individual.verification.document'],
      effectiveCardProvider: null,
    });

    // Una tarjeta guardada en esa cuenta: se da de baja al desautorizar.
    const card = await admin.paymentMethod.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        type: 'card',
        gateway: 'stripe',
        gatewayTokenEncrypted: 'x',
        stripeAccountId: accountId,
        isDefault: true,
      },
    });

    // El tenant quita el acceso desde Stripe.
    await send({
      id: `evt_deauth_${stamp}`,
      type: 'account.application.deauthorized',
      account: accountId,
      data: { object: { id: 'ca_x' } },
    }).expect(200);
    const after = await request(app.getHttpServer()).get('/settings/stripe-connect').set(auth);
    expect(after.body).toMatchObject({ connected: false, cardProvider: null });
    expect(await admin.paymentMethod.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      isDefault: false,
    });
    expect(
      (await admin.paymentMethod.findUniqueOrThrow({ where: { id: card.id } })).deletedAt,
    ).not.toBeNull();
  });
});
