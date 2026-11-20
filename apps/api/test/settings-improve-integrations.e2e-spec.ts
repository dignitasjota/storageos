/**
 * Mejoras de Integraciones: envío de prueba de un webhook, editarlo, los
 * eventos nuevos (baja pedida, contrato terminado, reserva online, cobro
 * rechazado) y la API pública de lectura con clave de API (inquilinos,
 * contratos y facturas, con permisos, páginas, filtros y límite por clave).
 */
import { createHmac } from 'node:crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';
import nock from 'nock';
import request from 'supertest';

import { DOMAIN_EVENTS } from '../src/modules/automations/domain-events';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { API_KEY_REQUESTS_PER_MINUTE } from '../src/modules/integrations/api-key-rate-limit.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timeout');
}

describe('Integraciones: mejoras (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    nock.disableNetConnect();
    nock.enableNetConnect(
      (host) =>
        host.includes('127.0.0.1') ||
        host.includes('localhost') ||
        host.includes('::1') ||
        host.includes(':5433') ||
        host.includes(':6380'),
    );
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.enableNetConnect();
    await app.close();
    await cleanupTestTenants();
  });

  afterEach(() => nock.cleanAll());

  async function createWebhook(owner: VerifiedUser, url: string, events: string[]) {
    const res = await http()
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Mi sistema', url, events });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, secret: res.body.secret as string };
  }

  async function deliveries(owner: VerifiedUser, webhookId: string) {
    const res = await http()
      .get(`/settings/webhooks/${webhookId}/deliveries`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    return res.body.items as Array<{
      id: string;
      eventType: string;
      status: string;
      payload: Record<string, unknown>;
    }>;
  }

  // ------------------------------------------------------------- webhooks

  it('envío de prueba: entrega real firmada, con test:true, aunque no esté suscrito', async () => {
    const owner = await registerVerifiedUser(app, 'sii-test');
    const hook = await createWebhook(owner, 'https://probe.example.test/in', ['lead.created']);

    let body: Record<string, unknown> | undefined;
    let signature: string | undefined;
    let eventHeader: string | undefined;
    nock('https://probe.example.test')
      .post('/in')
      .reply(function (_uri, reqBody) {
        body = reqBody as Record<string, unknown>;
        signature = this.req.headers['x-storageos-signature'] as string;
        eventHeader = this.req.headers['x-storageos-event'] as string;
        return [200, 'ok'];
      });

    const res = await http()
      .post(`/settings/webhooks/${hook.id}/test`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ event: 'booking.created' });
    expect(res.status).toBe(200);
    expect(res.body.event).toBe('booking.created');

    await waitFor(async () =>
      (await deliveries(owner, hook.id)).some(
        (d) => d.id === res.body.deliveryId && d.status === 'success',
      ),
    );
    expect(eventHeader).toBe('booking.created');
    expect(body?.test).toBe(true);
    expect(body?.type).toBe('booking.created');
    expect(body?.tenantId).toBe(owner.tenantId);
    // La firma vale con el secreto del webhook.
    const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signature ?? '');
    expect(m).toBeTruthy();
    const expected = createHmac('sha256', hook.secret)
      .update(`${m![1]}.${JSON.stringify(body)}`)
      .digest('hex');
    expect(m![2]).toBe(expected);

    // Sin cuerpo: un ping.
    const ping = await http()
      .post(`/settings/webhooks/${hook.id}/test`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(ping.status).toBe(200);
    expect(ping.body.event).toBe('ping');

    // Evento que no existe: 400.
    const bad = await http()
      .post(`/settings/webhooks/${hook.id}/test`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ event: 'invoice.created' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_event');

    // Queda auditado.
    const audit = await app.get(PrismaAdminService).auditLog.count({
      where: { tenantId: owner.tenantId, action: 'integration.webhook_test_sent' },
    });
    expect(audit).toBe(2);
  }, 30_000);

  it('editar un webhook: nombre, URL y eventos, con la misma comprobación de URL; revocado no', async () => {
    const owner = await registerVerifiedUser(app, 'sii-edit');
    const hook = await createWebhook(owner, 'https://one.example.test/a', ['invoice.paid']);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const edit = await http()
      .patch(`/settings/webhooks/${hook.id}`)
      .set(auth)
      .send({
        name: 'Contabilidad',
        url: 'https://two.example.test/b',
        events: ['payment.failed', 'contract.ended'],
      });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({
      name: 'Contabilidad',
      url: 'https://two.example.test/b',
      events: ['payment.failed', 'contract.ended'],
    });

    const internal = await http()
      .patch(`/settings/webhooks/${hook.id}`)
      .set(auth)
      .send({ url: 'http://127.0.0.1:9000/hook' });
    expect(internal.status).toBe(400);
    expect(internal.body.code).toBe('webhook_url_not_allowed');

    const audit = await app.get(PrismaAdminService).auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'integration.webhook_updated' },
    });
    expect((audit?.changes as { fields: string[] }).fields).toEqual(['name', 'url', 'events']);

    await http().delete(`/settings/webhooks/${hook.id}`).set(auth).expect(200);
    const afterRevoke = await http()
      .patch(`/settings/webhooks/${hook.id}`)
      .set(auth)
      .send({ name: 'Otra' });
    expect(afterRevoke.status).toBe(400);
    expect(afterRevoke.body.code).toBe('webhook_revoked');
    const testRevoked = await http().post(`/settings/webhooks/${hook.id}/test`).set(auth).send({});
    expect(testRevoked.status).toBe(400);
    expect(testRevoked.body.code).toBe('webhook_inactive');
  }, 30_000);

  it('eventos nuevos: baja pedida, contrato terminado, reserva online y cobro rechazado', async () => {
    const owner = await registerVerifiedUser(app, 'sii-events');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const hook = await createWebhook(owner, 'https://events.example.test/in', [
      'contract.move_out_requested',
      'contract.ended',
      'booking.created',
      'payment.failed',
    ]);
    nock('https://events.example.test').persist().post('/in').reply(200, 'ok');

    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Lucía' });
    const { contractId } = await signedContractFor(app, owner.accessToken, { id: customerId });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).send({}).expect(200);

    const events = app.get(EventEmitter2);
    const tenantId = owner.tenantId;
    events.emit(DOMAIN_EVENTS.contract_move_out_requested, {
      tenantId,
      entityType: 'contract',
      entityId: contractId,
      customerId,
      scope: { contract: { number: 'CT-1', endDate: '2026-12-31' } },
    });
    events.emit(DOMAIN_EVENTS.booking_created, { tenantId, contractId, customerId });
    events.emit(DOMAIN_EVENTS.payment_failed, {
      tenantId,
      invoiceId,
      customerId,
      amount: 60.5,
      reason: 'Fondos insuficientes',
    });
    // Terminar el contrato de verdad emite `contract_ended`.
    await http().post(`/contracts/${contractId}/end`).set(auth).send({}).expect(200);

    await waitFor(async () => {
      const types = new Set((await deliveries(owner, hook.id)).map((d) => d.eventType));
      return [
        'contract.move_out_requested',
        'contract.ended',
        'booking.created',
        'payment.failed',
      ].every((t) => types.has(t));
    });
    const list = await deliveries(owner, hook.id);
    const booking = list.find((d) => d.eventType === 'booking.created')!;
    expect(booking.payload).toMatchObject({
      entityType: 'contract',
      entityId: contractId,
      customerId,
      type: 'booking.created',
    });
    expect((booking.payload.scope as { customer: { firstName: string } }).customer.firstName).toBe(
      'Lucía',
    );
    const failed = list.find((d) => d.eventType === 'payment.failed')!;
    const scope = failed.payload.scope as {
      invoice: { number: string };
      payment: { amount: string; reason: string };
    };
    expect(scope.invoice.number).toMatch(/\S/);
    expect(scope.payment).toEqual({ amount: '60.50', reason: 'Fondos insuficientes' });
    // Nada de secretos en el cuerpo.
    expect(JSON.stringify(list.map((d) => d.payload))).not.toMatch(/signing|token|hash/i);
  }, 40_000);

  // ------------------------------------------------------------- API pública

  async function apiKey(owner: VerifiedUser, scopes: string[]): Promise<string> {
    const res = await http()
      .post('/settings/api-keys')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Integración', scopes });
    expect(res.status).toBe(201);
    return res.body.keyPlaintext as string;
  }

  it('API de lectura: inquilinos, contratos y facturas con permisos, páginas y filtros', async () => {
    const owner = await registerVerifiedUser(app, 'sii-api');
    const other = await registerVerifiedUser(app, 'sii-api-other');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const c1 = await createCustomer(app, owner.accessToken, { email: 'uno@e2e.local' });
    const c2 = await createCustomer(app, owner.accessToken);
    const { contractId } = await signedContractFor(app, owner.accessToken, { id: c1 });
    const draftId = await createDraftInvoice(app, owner.accessToken, c2);
    const issuedId = await createDraftInvoice(app, owner.accessToken, c1, { unitPrice: 50 });
    await http().post(`/invoices/${issuedId}/issue`).set(auth).send({}).expect(200);
    const otherCustomer = await createCustomer(app, other.accessToken);

    const readCustomers = await apiKey(owner, ['customers:read']);
    const readAll = await apiKey(owner, ['customers:read', 'contracts:read', 'invoices:read']);
    const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

    // Inquilinos por páginas.
    const p1 = await http().get('/integrations/customers?limit=1').set(bearer(readCustomers));
    expect(p1.status).toBe(200);
    expect(p1.headers['x-ratelimit-limit']).toBe(String(API_KEY_REQUESTS_PER_MINUTE));
    expect(p1.body.data).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await http()
      .get(`/integrations/customers?limit=1&cursor=${p1.body.nextCursor}`)
      .set(bearer(readCustomers));
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
    const ids = [p1.body.data[0].id, p2.body.data[0].id].sort();
    expect(ids).toEqual([c1, c2].sort());
    // Solo campos públicos (sin notas, portal ni contraseñas).
    for (const field of ['notes', 'portalPasswordHash', 'tenantId', 'emergencyContactPhone']) {
      expect(p1.body.data[0]).not.toHaveProperty(field);
    }

    const byEmail = await http()
      .get('/integrations/customers?email=UNO@e2e.local')
      .set(bearer(readCustomers));
    expect(byEmail.body.data.map((c: { id: string }) => c.id)).toEqual([c1]);

    // Otro negocio: 404.
    const cross = await http()
      .get(`/integrations/customers/${otherCustomer}`)
      .set(bearer(readCustomers));
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe('customer_not_found');

    // Sin permiso: 403.
    const noScope = await http().get('/integrations/invoices').set(bearer(readCustomers));
    expect(noScope.status).toBe(403);
    expect(noScope.body.code).toBe('insufficient_scope');

    // Contratos con filtro de estado.
    const contracts = await http()
      .get('/integrations/contracts?status=active')
      .set(bearer(readAll));
    expect(contracts.status).toBe(200);
    expect(contracts.body.data).toHaveLength(1);
    expect(contracts.body.data[0]).toMatchObject({
      id: contractId,
      customerId: c1,
      status: 'active',
      priceMonthly: 50,
    });
    expect(contracts.body.data[0].unitCode).toBeTruthy();
    expect(contracts.body.data[0]).not.toHaveProperty('signedTermsText');
    const badStatus = await http().get('/integrations/contracts?status=foo').set(bearer(readAll));
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe('invalid_status');

    // Facturas: sin borradores, con líneas e importe pendiente.
    const invoices = await http().get('/integrations/invoices').set(bearer(readAll));
    expect(invoices.status).toBe(200);
    const invIds = invoices.body.data.map((i: { id: string }) => i.id);
    expect(invIds).toContain(issuedId);
    expect(invIds).not.toContain(draftId);
    const inv = await http().get(`/integrations/invoices/${issuedId}`).set(bearer(readAll));
    expect(inv.status).toBe(200);
    expect(inv.body).toMatchObject({ status: 'issued', total: 60.5, amountPending: 60.5 });
    expect(inv.body.items[0]).toMatchObject({ unitPrice: 50, taxRate: 21, total: 60.5 });
    expect(inv.body).not.toHaveProperty('hash');
    expect(inv.body).not.toHaveProperty('pdfUrl');
    const draft = await http().get(`/integrations/invoices/${draftId}`).set(bearer(readAll));
    expect(draft.status).toBe(404);

    // updatedSince en el futuro: nada; fecha mala: 400.
    const future = await http()
      .get('/integrations/invoices?updatedSince=2100-01-01T00:00:00Z')
      .set(bearer(readAll));
    expect(future.body.data).toEqual([]);
    const badDate = await http()
      .get('/integrations/invoices?updatedSince=ayer')
      .set(bearer(readAll));
    expect(badDate.status).toBe(400);
    expect(badDate.body.code).toBe('invalid_date');
  }, 60_000);

  it(`límite de ${API_KEY_REQUESTS_PER_MINUTE} peticiones por minuto y clave`, async () => {
    const owner = await registerVerifiedUser(app, 'sii-rate');
    const key = await apiKey(owner, ['invoices:read']);
    const other = await apiKey(owner, ['invoices:read']);
    // Ventana de un minuto: si estamos justo al final, se espera a la siguiente.
    const msLeft = 60_000 - (Date.now() % 60_000);
    if (msLeft < 20_000) await new Promise((r) => setTimeout(r, msLeft + 200));

    let last = 0;
    for (let i = 0; i < API_KEY_REQUESTS_PER_MINUTE; i++) {
      const res = await http().get('/integrations/whoami').set('Authorization', `Bearer ${key}`);
      last = res.status;
      if (res.status !== 200) break;
    }
    expect(last).toBe(200);
    const over = await http().get('/integrations/whoami').set('Authorization', `Bearer ${key}`);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    // Otra clave del mismo negocio sigue funcionando.
    const second = await http().get('/integrations/whoami').set('Authorization', `Bearer ${other}`);
    expect(second.status).toBe(200);
  }, 90_000);
});
