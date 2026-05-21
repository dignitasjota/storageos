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

  it('retry manual de delivery failed: reset attempts, queued y eventual success en el reintento', async () => {
    const owner = await registerVerifiedUser(app, 'wh-retry');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Retry hook',
        url: 'https://hook.example.test/retry',
        events: ['lead.created'],
      });
    expect(create.status).toBe(201);
    const webhookId = create.body.id as string;

    // 1) Forzar 3 fallos 500 -> delivery failed.
    const failScope = nock('https://hook.example.test').persist().post('/retry').reply(500, 'oops');

    const { WebhooksService } = await import('../src/modules/integrations/webhooks.service');
    const svc = app.get(WebhooksService);
    await svc.dispatch(owner.tenantId, 'lead.created', {
      tenantId: owner.tenantId,
      sample: 'retry-payload',
    });

    const queue = getQueue(app);
    await waitFor(async () => {
      const delayed = await queue.getDelayed();
      for (const j of delayed) {
        try {
          await j.promote();
        } catch {
          // ignore
        }
      }
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      if (list.status !== 200) return false;
      return list.body.items[0]?.status === 'failed';
    }, 25_000);

    const failedList = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const deliveryId = failedList.body.items[0].id as string;
    expect(failedList.body.items[0].status).toBe('failed');

    // 2) Cambiar nock a 200 para el reintento.
    nock.cleanAll();
    failScope.persist(false);
    nock('https://hook.example.test').post('/retry').reply(200, { ok: true });

    // 3) Retry manual.
    const retryRes = await request(app.getHttpServer())
      .post(`/settings/webhooks/${webhookId}/deliveries/${deliveryId}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body).toEqual({ queued: true });

    // 4) Worker procesa -> success, attempts=1.
    await waitFor(async () => {
      const delayed = await queue.getDelayed();
      for (const j of delayed) {
        try {
          await j.promote();
        } catch {
          // ignore
        }
      }
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries/?limit=10`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      if (list.status !== 200) return false;
      const found = list.body.items.find((d: { id: string }) => d.id === deliveryId);
      return found?.status === 'success';
    }, 20_000);

    const final = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const d = final.body.items.find((row: { id: string }) => row.id === deliveryId);
    expect(d.status).toBe('success');
    expect(d.attempts).toBe(1);
    expect(d.statusCode).toBe(200);
    expect(d.errorMessage).toBeNull();
  }, 60_000);

  it('retry de un delivery success -> 400 delivery_not_retryable', async () => {
    const owner = await registerVerifiedUser(app, 'wh-retry-bad');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Success retry hook',
        url: 'https://hook.example.test/retry-success',
        events: ['lead.created'],
      });
    expect(create.status).toBe(201);
    const webhookId = create.body.id as string;

    nock('https://hook.example.test').post('/retry-success').reply(200, { ok: true });

    const { WebhooksService } = await import('../src/modules/integrations/webhooks.service');
    const svc = app.get(WebhooksService);
    await svc.dispatch(owner.tenantId, 'lead.created', {
      tenantId: owner.tenantId,
      sample: 'success-payload',
    });

    await waitFor(async () => {
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      return (
        list.status === 200 &&
        list.body.items.some((d: { status: string }) => d.status === 'success')
      );
    });

    const list = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const deliveryId = list.body.items[0].id as string;

    const retryRes = await request(app.getHttpServer())
      .post(`/settings/webhooks/${webhookId}/deliveries/${deliveryId}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(retryRes.status).toBe(400);
    expect(retryRes.body.code ?? retryRes.body.message?.code).toBeDefined();
    const code = retryRes.body.code ?? retryRes.body.message?.code;
    expect(code).toBe('delivery_not_retryable');
  }, 20_000);

  it('retry de un delivery de otro tenant -> 404', async () => {
    const ownerA = await registerVerifiedUser(app, 'wh-retry-iso-a');
    const ownerB = await registerVerifiedUser(app, 'wh-retry-iso-b');

    const createA = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'A hook',
        url: 'https://hook.example.test/iso-retry',
        events: ['lead.created'],
      });
    expect(createA.status).toBe(201);
    const webhookId = createA.body.id as string;

    nock('https://hook.example.test').persist().post('/iso-retry').reply(500, 'oops');

    const { WebhooksService } = await import('../src/modules/integrations/webhooks.service');
    const svc = app.get(WebhooksService);
    await svc.dispatch(ownerA.tenantId, 'lead.created', {
      tenantId: ownerA.tenantId,
      sample: 'iso',
    });

    const queue = getQueue(app);
    await waitFor(async () => {
      const delayed = await queue.getDelayed();
      for (const j of delayed) {
        try {
          await j.promote();
        } catch {
          // ignore
        }
      }
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      if (list.status !== 200) return false;
      return list.body.items[0]?.status === 'failed';
    }, 25_000);

    const list = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    const deliveryId = list.body.items[0].id as string;

    // Tenant B intenta retry sobre el delivery de A: 404 (no encuentra el webhook).
    const retryRes = await request(app.getHttpServer())
      .post(`/settings/webhooks/${webhookId}/deliveries/${deliveryId}/retry`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(retryRes.status).toBe(404);
  }, 40_000);

  it('listar deliveries con filtro status=failed devuelve solo failed', async () => {
    const owner = await registerVerifiedUser(app, 'wh-filter');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Filter hook',
        url: 'https://hook.example.test/filter',
        events: ['lead.created'],
      });
    expect(create.status).toBe(201);
    const webhookId = create.body.id as string;

    // 1) Un delivery que va a success.
    nock('https://hook.example.test').post('/filter').reply(200, { ok: true });
    const { WebhooksService } = await import('../src/modules/integrations/webhooks.service');
    const svc = app.get(WebhooksService);
    await svc.dispatch(owner.tenantId, 'lead.created', {
      tenantId: owner.tenantId,
      sample: 'ok',
    });

    await waitFor(async () => {
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      return (
        list.status === 200 &&
        list.body.items.some((d: { status: string }) => d.status === 'success')
      );
    });

    // 2) Otro delivery que falla.
    nock.cleanAll();
    nock('https://hook.example.test').persist().post('/filter').reply(500, 'oops');
    await svc.dispatch(owner.tenantId, 'lead.created', {
      tenantId: owner.tenantId,
      sample: 'fail',
    });

    const queue = getQueue(app);
    await waitFor(async () => {
      const delayed = await queue.getDelayed();
      for (const j of delayed) {
        try {
          await j.promote();
        } catch {
          // ignore
        }
      }
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries?status=failed`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      if (list.status !== 200) return false;
      return list.body.items.length >= 1;
    }, 25_000);

    // 3) Filtro status=failed: solo failed.
    const failedList = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries?status=failed`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(failedList.status).toBe(200);
    expect(failedList.body.items.length).toBeGreaterThanOrEqual(1);
    for (const d of failedList.body.items) {
      expect(d.status).toBe('failed');
    }

    // 4) Filtro status=success: solo success.
    const successList = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries?status=success`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(successList.status).toBe(200);
    expect(successList.body.items.length).toBeGreaterThanOrEqual(1);
    for (const d of successList.body.items) {
      expect(d.status).toBe('success');
    }
  }, 60_000);

  it('paginacion cursor: limit=1 devuelve nextCursor y el siguiente fetch trae filas distintas', async () => {
    const owner = await registerVerifiedUser(app, 'wh-paginate');
    const create = await request(app.getHttpServer())
      .post('/settings/webhooks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Paginate hook',
        url: 'https://hook.example.test/paginate',
        events: ['lead.created'],
      });
    expect(create.status).toBe(201);
    const webhookId = create.body.id as string;

    nock('https://hook.example.test').persist().post('/paginate').reply(200, { ok: true });

    const { WebhooksService } = await import('../src/modules/integrations/webhooks.service');
    const svc = app.get(WebhooksService);
    // Disparar 3 entregas separadas.
    for (let i = 0; i < 3; i += 1) {
      await svc.dispatch(owner.tenantId, 'lead.created', {
        tenantId: owner.tenantId,
        idx: i,
      });
    }

    await waitFor(async () => {
      const list = await request(app.getHttpServer())
        .get(`/settings/webhooks/${webhookId}/deliveries?limit=10`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      if (list.status !== 200) return false;
      const successes = list.body.items.filter((d: { status: string }) => d.status === 'success');
      return successes.length >= 3;
    }, 25_000);

    const page1 = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries?limit=1`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.items.length).toBe(1);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app.getHttpServer())
      .get(`/settings/webhooks/${webhookId}/deliveries?limit=1&cursor=${page1.body.nextCursor}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items.length).toBe(1);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  }, 60_000);

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
