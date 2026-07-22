import { createHmac } from 'node:crypto';

import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('GoCardless settings + webhook (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('config cifrada (no devuelve secretos) + webhook firmado', async () => {
    const owner = await registerVerifiedUser(app, 'gocardless');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const webhookSecret = 'whsec_test_gocardless_123456';

    // Por defecto vacío.
    const before = await request(app.getHttpServer()).get('/settings/gocardless').set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      enabled: false,
      hasAccessToken: false,
      hasWebhookSecret: false,
    });

    // Guardar credenciales + activar.
    const save = await request(app.getHttpServer()).put('/settings/gocardless').set(auth).send({
      accessToken: 'sandbox_token_abcdef123456',
      webhookSecret,
      environment: 'sandbox',
      enabled: true,
    });
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({
      environment: 'sandbox',
      enabled: true,
      hasAccessToken: true,
      hasWebhookSecret: true,
    });
    // Nunca devuelve el token ni el secret en claro.
    expect(JSON.stringify(save.body)).not.toContain('sandbox_token');
    expect(JSON.stringify(save.body)).not.toContain(webhookSecret);

    // Webhook con firma VÁLIDA → 200.
    const body = JSON.stringify({ events: [{ id: 'EV1', action: 'created' }] });
    const sig = createHmac('sha256', webhookSecret).update(body).digest('hex');
    const ok = await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', sig)
      .send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });

    // Webhook con firma INVÁLIDA → 400.
    const bad = await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', 'deadbeef')
      .send(body);
    expect(bad.status).toBe(400);
  });

  it('no deja activar sin credenciales', async () => {
    const owner = await registerVerifiedUser(app, 'gocardless-noc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const res = await request(app.getHttpServer())
      .put('/settings/gocardless')
      .set(auth)
      .send({ environment: 'sandbox', enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('gocardless_credentials_required');
  });

  it('mandato (staff): start → complete → método de pago SEPA registrado', async () => {
    const owner = await registerVerifiedUser(app, 'gocardless-mandate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, { email: 'gc-m@e2e.local' });

    // start sin GoCardless activado → 400.
    const notEnabled = await request(app.getHttpServer())
      .post('/settings/gocardless/mandate/start')
      .set(auth)
      .send({ customerId });
    expect(notEnabled.status).toBe(400);
    expect(notEnabled.body.code).toBe('gocardless_not_enabled');

    // Activar GoCardless.
    await request(app.getHttpServer()).put('/settings/gocardless').set(auth).send({
      accessToken: 'sandbox_token_mandate_123456',
      webhookSecret: 'whsec_mandate_123456',
      environment: 'sandbox',
      enabled: true,
    });

    // start → URL de autorización (stub) + billingRequestId.
    const start = await request(app.getHttpServer())
      .post('/settings/gocardless/mandate/start')
      .set(auth)
      .send({ customerId });
    expect(start.status).toBe(200);
    expect(start.body.authorisationUrl).toContain('gocardless.com');
    expect(typeof start.body.billingRequestId).toBe('string');

    // complete → registra el PaymentMethod SEPA (gateway gocardless).
    const complete = await request(app.getHttpServer())
      .post('/settings/gocardless/mandate/complete')
      .set(auth)
      .send({ customerId, billingRequestId: start.body.billingRequestId });
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({
      customerId,
      gateway: 'gocardless',
      type: 'sepa_debit',
      isDefault: true,
      last4: '0001',
    });
    expect(complete.body.mandateReference).toBeTruthy();

    // Aparece en los métodos de pago del cliente.
    const pms = await request(app.getHttpServer())
      .get(`/customers/${customerId}/payment-methods`)
      .set(auth);
    expect(pms.body.some((pm: { gateway: string }) => pm.gateway === 'gocardless')).toBe(true);
  });

  it('cobro: charge → payment processing → webhook confirmed marca la factura pagada', async () => {
    const owner = await registerVerifiedUser(app, 'gocardless-charge');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const webhookSecret = 'whsec_charge_123456';
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken, { email: 'gc-c@e2e.local' });

    // Activar GoCardless + crear el mandato (PM SEPA default).
    await request(app.getHttpServer()).put('/settings/gocardless').set(auth).send({
      accessToken: 'sandbox_token_charge_123456',
      webhookSecret,
      environment: 'sandbox',
      enabled: true,
    });
    const start = await request(app.getHttpServer())
      .post('/settings/gocardless/mandate/start')
      .set(auth)
      .send({ customerId });
    await request(app.getHttpServer())
      .post('/settings/gocardless/mandate/complete')
      .set(auth)
      .send({ customerId, billingRequestId: start.body.billingRequestId });

    // Factura emitida.
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);

    // Cobro por GoCardless → queda `processing` (espera al webhook).
    const charge = await request(app.getHttpServer())
      .post(`/payments/invoices/${invoiceId}/charge`)
      .set(auth)
      .send({});
    expect(charge.status).toBe(200);
    expect(charge.body).toMatchObject({ gateway: 'gocardless', status: 'processing' });
    const gatewayPaymentId = charge.body.gatewayPaymentId as string;
    expect(gatewayPaymentId).toContain('PM-stub-');

    // La factura aún no está pagada.
    const before = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(before.body.status).not.toBe('paid');

    // Webhook payments.confirmed → marca la factura pagada.
    const body = JSON.stringify({
      events: [
        {
          id: 'EV-pay',
          resource_type: 'payments',
          action: 'confirmed',
          links: { payment: gatewayPaymentId },
        },
      ],
    });
    const sig = createHmac('sha256', webhookSecret).update(body).digest('hex');
    const hook = await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', sig)
      .send(body);
    expect(hook.status).toBe(200);

    const after = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(after.body.status).toBe('paid');
    const paidOnce = after.body.amountPaid as number;

    // Dedup: reenviar el MISMO evento `EV-pay` (GoCardless reentrega lotes) NO
    // debe volver a sumar al amountPaid.
    const dup = await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', sig)
      .send(body);
    expect(dup.status).toBe(200);
    const afterDup = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(afterDup.body.amountPaid).toBe(paidOnce);

    // Devolución (charged_back): revierte el cobro → la factura deja de estar pagada.
    const cbBody = JSON.stringify({
      events: [
        {
          id: 'EV-cb',
          resource_type: 'payments',
          action: 'charged_back',
          links: { payment: gatewayPaymentId },
        },
      ],
    });
    const cbSig = createHmac('sha256', webhookSecret).update(cbBody).digest('hex');
    await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', cbSig)
      .send(cbBody)
      .expect(200);

    const reverted = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(reverted.body.status).not.toBe('paid');
    expect(Number(reverted.body.amountPaid)).toBe(0);
  });

  it('reembolso: una factura cobrada por GoCardless se reembolsa por su API', async () => {
    const owner = await registerVerifiedUser(app, 'gocardless-refund');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const webhookSecret = 'whsec_refund_123456';
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken, { email: 'gc-r@e2e.local' });

    await request(app.getHttpServer()).put('/settings/gocardless').set(auth).send({
      accessToken: 'sandbox_token_refund_123456',
      webhookSecret,
      environment: 'sandbox',
      enabled: true,
    });
    const start = await request(app.getHttpServer())
      .post('/settings/gocardless/mandate/start')
      .set(auth)
      .send({ customerId });
    await request(app.getHttpServer())
      .post('/settings/gocardless/mandate/complete')
      .set(auth)
      .send({ customerId, billingRequestId: start.body.billingRequestId });

    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);

    // Cobro + confirmación por webhook → factura pagada (100 €).
    const charge = await request(app.getHttpServer())
      .post(`/payments/invoices/${invoiceId}/charge`)
      .set(auth)
      .send({});
    const gatewayPaymentId = charge.body.gatewayPaymentId as string;
    // Id de evento único por tenant: `processed_gocardless_events` es global y no
    // se limpia entre runs → un id fijo daría "duplicado" en la 2ª ejecución.
    const okBody = JSON.stringify({
      events: [
        {
          id: `EV-refund-pay-${owner.tenantId}`,
          resource_type: 'payments',
          action: 'confirmed',
          links: { payment: gatewayPaymentId },
        },
      ],
    });
    await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', createHmac('sha256', webhookSecret).update(okBody).digest('hex'))
      .send(okBody)
      .expect(200);
    const paid = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(paid.body.status).toBe('paid');

    // La factura de 100 € lleva IVA 21% → total 121 €.
    expect(Number(paid.body.total)).toBe(121);

    // Reembolso parcial (40 €) → se procesa por la API de GoCardless (stub),
    // la factura queda `partially_refunded` (antes daba 400 refund_not_supported_gateway).
    const refund = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/refund`)
      .set(auth)
      .send({ amount: 40, reason: 'baja anticipada' });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe('partially_refunded');
    expect(Number(refund.body.amountRefunded)).toBe(40);

    // Reembolso del resto (81 €) → total 121, factura totalmente reembolsada.
    const rest = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/refund`)
      .set(auth)
      .send({ amount: 81 });
    expect(rest.status).toBe(200);
    expect(rest.body.status).toBe('refunded');
    expect(Number(rest.body.amountRefunded)).toBe(121);
  });
});
