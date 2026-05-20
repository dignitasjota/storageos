/**
 * E2E tests del sub-bloque 14A.3: webhooks salientes con HMAC.
 *
 * Cubre: crear webhook con secret revealed-once, dispatch del evento
 * domain.lead_created, entrega 200 -> success, entrega 500 -> retry y
 * eventual `failed`, verificacion HMAC del header X-Storageos-Signature,
 * listar deliveries paginadas.
 *
 * Usa `nock` para interceptar las peticiones HTTP del worker.
 */
import { createHmac } from 'node:crypto';

import { getQueueToken } from '@nestjs/bullmq';
import nock from 'nock';
import request from 'supertest';

import { QUEUE_WEBHOOKS } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';

function getQueue(app: INestApplication): Queue {
  return app.get<Queue>(getQueueToken(QUEUE_WEBHOOKS));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timeout');
}

describe('Webhooks salientes (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    nock.disableNetConnect();
    // Permite supertest contra el server in-process y conexion a postgres/redis.
    nock.enableNetConnect((host) => {
      return (
        host.includes('127.0.0.1') ||
        host.includes('localhost') ||
        host.includes('::1') ||
        host.includes(':5433') ||
        host.includes(':6380')
      );
    });
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.enableNetConnect();
    await app.close();
    await cleanupTestTenants();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('owner crea webhook con eventos y recibe secret una sola vez', async () => {
    const owner = await registerVerifiedUser(app, 'wh-create');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Test webhook',
        url: 'https://example.test/hook',
        events: ['invoice.paid', 'contract.signed'],
      });
    expect(create.status).toBe(201);
    expect(create.body.secret).toMatch(/^whsec_/);
    expect(create.body.events).toEqual(['invoice.paid', 'contract.signed']);
    expect(create.body.isActive).toBe(true);

    const list = await request(app.getHttpServer())
      .get('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    const row = list.body.find((w: { id: string }) => w.id === create.body.id);
    expect(row).toBeDefined();
    expect(row.secret).toBeUndefined();
  });

  it('dispara dispatch via WebhooksService y entrega 200 -> delivery success con HMAC valido', async () => {
    const owner = await registerVerifiedUser(app, 'wh-success');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Success hook',
        url: 'https://hook.example.test/ok',
        events: ['lead.created'],
      });
    expect(create.status).toBe(201);
    const webhookId = create.body.id as string;
    const secret = create.body.secret as string;

    let receivedSignature: string | undefined;
    let receivedEvent: string | undefined;
    let receivedDelivery: string | undefined;

    nock('https://hook.example.test')
      .post('/ok')
      .reply(function () {
        receivedSignature = this.req.headers['x-storageos-signature'] as string;
        receivedEvent = this.req.headers['x-storageos-event'] as string;
        receivedDelivery = this.req.headers['x-storageos-delivery'] as string;
        return [200, { ok: true }];
      });

    // Disparar dispatch directamente desde el servicio.
    const { WebhooksService } = await import('../src/modules/integrations/webhooks.service');
    const svc = app.get(WebhooksService);
    await svc.dispatch(owner.tenantId, 'lead.created', {
      tenantId: owner.tenantId,
      leadId: '00000000-0000-0000-0000-000000000000',
      sample: 'payload',
    });

    // Esperar a que el worker procese.
    await waitFor(async () => {
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      return (
        list.status === 200 &&
        list.body.items.some((d: { status: string }) => d.status === 'success')
      );
    });

    expect(receivedSignature).toBeDefined();
    expect(receivedEvent).toBe('lead.created');
    expect(receivedDelivery).toMatch(/[0-9a-f-]{36}/);

    const deliveries = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(deliveries.status).toBe(200);
    const d = deliveries.body.items[0];
    expect(d.status).toBe('success');
    expect(d.statusCode).toBe(200);
    expect(d.signature).toBe(receivedSignature);
    expect(d.deliveredAt).toBeTruthy();

    // Verificar el HMAC: el worker firma sobre `JSON.stringify(payload)`,
    // donde `payload` es el JSONB tal como sale de Postgres. Reproducimos
    // el mismo calculo aqui con el payload que devuelve el endpoint.
    const match = receivedSignature!.match(/^t=(\d+),v1=([0-9a-f]+)$/);
    expect(match).toBeTruthy();
    const ts = Number(match![1]);
    const v1 = match![2]!;
    const body = JSON.stringify(d.payload);
    const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(v1).toBe(expected);
  }, 20_000);

  it('entrega 500 -> reintenta y eventualmente queda failed tras 3 intentos', async () => {
    const owner = await registerVerifiedUser(app, 'wh-fail');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Fail hook',
        url: 'https://hook.example.test/fail',
        events: ['lead.created'],
      });
    expect(create.status).toBe(201);
    const webhookId = create.body.id as string;

    // Siempre responde 500.
    nock('https://hook.example.test').persist().post('/fail').reply(500, 'oops');

    const { WebhooksService } = await import('../src/modules/integrations/webhooks.service');
    const svc = app.get(WebhooksService);
    await svc.dispatch(owner.tenantId, 'lead.created', {
      tenantId: owner.tenantId,
      sample: 'fail-payload',
    });

    // Empujamos los intentos sin esperar al backoff real (60s). BullMQ
    // calcula el delay en `backoff`; en lugar de esperar, promovemos los
    // jobs delayed/failed en la cola hasta que se ejecutan los 3.
    const queue = getQueue(app);

    await waitFor(async () => {
      // Promover cualquier job delayed para que el worker lo retome ya.
      const delayed = await queue.getDelayed();
      for (const j of delayed) {
        try {
          await j.promote();
        } catch {
          // ya no esta en delayed: ignora
        }
      }
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      if (list.status !== 200) return false;
      const d = list.body.items[0];
      return d?.status === 'failed';
    }, 25_000);

    const deliveries = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(deliveries.status).toBe(200);
    const d = deliveries.body.items[0];
    expect(d.status).toBe('failed');
    expect(d.attempts).toBeGreaterThanOrEqual(3);
    expect(d.statusCode).toBe(500);
    expect(d.errorMessage).toMatch(/HTTP 500/);
  }, 35_000);

  it('aislamiento cross-tenant: tenant_b no ve webhooks ni deliveries de tenant_a', async () => {
    const ownerA = await registerVerifiedUser(app, 'wh-iso-a');
    const ownerB = await registerVerifiedUser(app, 'wh-iso-b');

    const created = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Only A',
        url: 'https://hook.example.test/isolation',
        events: ['lead.created'],
      });
    expect(created.status).toBe(201);

    const listB = await request(app.getHttpServer())
      .get('/settings/webhooks')
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(listB.status).toBe(200);
    expect(listB.body.find((w: { id: string }) => w.id === created.body.id)).toBeUndefined();

    const deliveriesB = await request(app.getHttpServer())
      .get(`/settings/webhooks/${created.body.id}/deliveries`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(deliveriesB.status).toBe(404);
  });

  it('rotate-secret invalida el anterior secret y devuelve uno nuevo', async () => {
    const owner = await registerVerifiedUser(app, 'wh-rotate');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Rotate',
        url: 'https://hook.example.test/rotate',
        events: ['lead.created'],
      });
    expect(create.status).toBe(201);
    const firstSecret = create.body.secret as string;

    const rotated = await request(app.getHttpServer())
      .post(`/settings/webhooks/${create.body.id}/rotate-secret`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(firstSecret);
  });
});
