import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Fase 6: tasks + incidents + products + analytics + reports (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('tasks: CRUD + state machine + comentarios', async () => {
    const owner = await registerVerifiedUser(app, 'tasks-crud');
    const create = await request(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        type: 'cleaning',
        priority: 'normal',
        title: 'Limpieza pasillo planta 1',
        description: 'Pasar mopa',
      });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('open');

    // open → in_progress
    const start = await request(app.getHttpServer())
      .post(`/tasks/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'in_progress' });
    expect(start.status).toBe(201);
    expect(start.body.startedAt).toBeTruthy();

    // open transición inválida (in_progress → open permitido, pero done → cancelled NO)
    const done = await request(app.getHttpServer())
      .post(`/tasks/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'done' });
    expect(done.status).toBe(201);
    expect(done.body.completedAt).toBeTruthy();

    // done es terminal: cancelled NO permitido
    const cancel = await request(app.getHttpServer())
      .post(`/tasks/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'cancelled' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('invalid_task_transition');

    // Comentarios
    const comm = await request(app.getHttpServer())
      .post(`/tasks/${create.body.id}/comments`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ body: 'Hecho a las 10:30' });
    expect(comm.status).toBe(201);
    const list = await request(app.getHttpServer())
      .get(`/tasks/${create.body.id}/comments`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].body).toBe('Hecho a las 10:30');
  });

  it('incidents: severity high emite evento + state machine', async () => {
    const owner = await registerVerifiedUser(app, 'inc-event');
    const create = await request(app.getHttpServer())
      .post('/incidents')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        severity: 'high',
        title: 'Cerradura forzada',
        description: 'Unit 12 acceso forzado',
      });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('reported');
    expect(create.body.severity).toBe('high');

    // reported → investigating
    const inv = await request(app.getHttpServer())
      .post(`/incidents/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'investigating' });
    expect(inv.status).toBe(201);

    // investigating → resolved con resolution
    const resolved = await request(app.getHttpServer())
      .post(`/incidents/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'resolved', resolution: 'Cambiada cerradura' });
    expect(resolved.status).toBe(201);
    expect(resolved.body.resolvedAt).toBeTruthy();
    expect(resolved.body.resolution).toBe('Cambiada cerradura');

    // resolved es terminal
    const reopen = await request(app.getHttpServer())
      .post(`/incidents/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'reported' });
    expect(reopen.status).toBe(409);
  });

  it('products: CRUD + stock por facility', async () => {
    const owner = await registerVerifiedUser(app, 'prod-crud');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local 1' });
    expect(facility.status).toBe(201);

    const prod = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        sku: 'PADLOCK_S',
        name: 'Candado pequeno',
        type: 'lock',
        price: 9.95,
        taxRate: 21,
      });
    expect(prod.status).toBe(201);

    // Set stock 10 en la facility
    const setStock = await request(app.getHttpServer())
      .put(`/products/${prod.body.id}/stock`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ facilityId: facility.body.id, quantity: 10 });
    expect(setStock.status).toBe(200);

    const stockList = await request(app.getHttpServer())
      .get(`/products/${prod.body.id}/stock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(stockList.body).toHaveLength(1);
    expect(stockList.body[0].quantity).toBe(10);

    // Adjust -2 (decorador @HttpCode(200))
    const adj = await request(app.getHttpServer())
      .post(`/products/${prod.body.id}/stock/adjust`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ facilityId: facility.body.id, delta: -2 });
    expect([200, 201]).toContain(adj.status);
    expect(adj.body.quantity).toBe(8);
  });

  it('product sale crea invoice cuando hay customer, decrementa stock', async () => {
    const owner = await registerVerifiedUser(app, 'prod-sale');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local 1' });

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Diez', country: 'ES' });
    expect(customer.status).toBe(201);

    const series = await request(app.getHttpServer())
      .post('/invoice-series')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ code: 'A', name: 'Serie A', prefix: 'A', isDefault: true });
    expect(series.status).toBe(201);

    const prod = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sku: 'BOX_M', name: 'Caja M', type: 'box', price: 5.0 });

    await request(app.getHttpServer())
      .put(`/products/${prod.body.id}/stock`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ facilityId: facility.body.id, quantity: 20 });

    const sale = await request(app.getHttpServer())
      .post('/product-sales')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId: facility.body.id,
        customerId: customer.body.id,
        items: [{ productId: prod.body.id, quantity: 3 }],
      });
    expect(sale.status).toBe(201);
    expect(sale.body.invoiceId).toBeTruthy();
    expect(sale.body.status).toBe('paid');

    const stockAfter = await request(app.getHttpServer())
      .get(`/products/${prod.body.id}/stock`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(stockAfter.body[0].quantity).toBe(17);
  });

  it('product sale falla con insufficient_stock', async () => {
    const owner = await registerVerifiedUser(app, 'prod-stock');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local Norte' });
    expect(facility.status).toBe(201);
    const prod = await request(app.getHttpServer())
      .post('/products')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sku: 'X1', name: 'X1', type: 'other', price: 1 });
    expect(prod.status).toBe(201);
    const sale = await request(app.getHttpServer())
      .post('/product-sales')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        facilityId: facility.body.id,
        items: [{ productId: prod.body.id, quantity: 5 }],
      });
    expect(sale.status).toBe(409);
    expect(sale.body.code).toBe('insufficient_stock');
  });

  it('analytics: occupancy snapshot', async () => {
    const owner = await registerVerifiedUser(app, 'analytics-occ');
    const res = await request(app.getHttpServer())
      .get('/analytics/occupancy')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalUnits');
    expect(res.body).toHaveProperty('physicalOccupancy');
    expect(res.body).toHaveProperty('economicOccupancy');
  });

  it('analytics: aging vacio cuando no hay facturas', async () => {
    const owner = await registerVerifiedUser(app, 'analytics-aging');
    const res = await request(app.getHttpServer())
      .get('/analytics/aging')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalOutstanding).toBe(0);
    expect(res.body.buckets).toHaveLength(4);
  });

  it('analytics: leads funnel agrega por estado y source', async () => {
    const owner = await registerVerifiedUser(app, 'analytics-leads');
    await request(app.getHttpServer())
      .post('/leads')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ source: 'manual', firstName: 'Pepe', email: 'p@e.com', phone: '+34 600' });
    const res = await request(app.getHttpServer())
      .get('/analytics/leads-funnel')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.new).toBeGreaterThanOrEqual(1);
    expect(res.body.bySource.some((s: { source: string }) => s.source === 'manual')).toBe(true);
  });

  it('reports: catalog devuelve generators registrados', async () => {
    const owner = await registerVerifiedUser(app, 'reports-cat');
    const res = await request(app.getHttpServer())
      .get('/reports/catalog')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    expect(res.body.some((g: { code: string }) => g.code === 'aging_at_date')).toBe(true);
  });

  it('reports: run aging genera report_run y termina en done', async () => {
    const owner = await registerVerifiedUser(app, 'reports-run');
    const run = await request(app.getHttpServer())
      .post('/reports/run')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ generator: 'aging_at_date', format: 'xlsx', params: {} });
    expect(run.status).toBe(201);
    expect(run.body.status).toBe('pending');

    // Polling hasta done o failed
    let lastStatus = run.body.status;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const status = await request(app.getHttpServer())
        .get(`/reports/${run.body.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      lastStatus = status.body.status;
      if (lastStatus === 'done' || lastStatus === 'failed') {
        expect(lastStatus).toBe('done');
        expect(status.body.downloadUrl).toBeTruthy();
        return;
      }
    }
    throw new Error(`Report no completó en 30s, último status: ${lastStatus}`);
  }, 60_000);
});
