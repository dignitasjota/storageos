import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Tests e2e del sub-bloque 13A.3 - factura simplificada F2 sin
 * destinatario identificado (RD 1619/2012 art. 7). Verifican:
 *  - Creacion sin customerId con totales <= 400 EUR.
 *  - Validacion de limite 400 EUR sin justificacion / 3000 EUR con.
 *  - Issue de la F2 y persistencia del invoice_type.
 *  - F1 sigue exigiendo customerId.
 */
describe('Invoice F2 simplificada (e2e)', () => {
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

  it('crea una F2 sin customer con total 300 EUR (sin justificacion)', async () => {
    const owner = await registerVerifiedUser(app, 'f2-basic');
    await ensureDefaultSeries(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        invoiceType: 'F2',
        items: [
          {
            description: 'Candado para trastero',
            quantity: 1,
            unitPrice: 247.93, // 247.93 + IVA 21% = 299.99
            taxRate: 21,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.invoiceType).toBe('F2');
    expect(res.body.customerId).toBeNull();
    expect(res.body.customerName).toBeNull();
    expect(Number(res.body.total)).toBeLessThanOrEqual(400);
  });

  it('rechaza F2 con total 500 EUR sin justificacion (400 f2_amount_limit_exceeded)', async () => {
    const owner = await registerVerifiedUser(app, 'f2-overlimit');
    await ensureDefaultSeries(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        invoiceType: 'F2',
        items: [
          {
            description: 'Articulo',
            quantity: 1,
            unitPrice: 500,
            taxRate: 0,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('f2_amount_limit_exceeded');
  });

  it('acepta F2 con total 500 EUR si trae justificacion transport', async () => {
    const owner = await registerVerifiedUser(app, 'f2-justified');
    await ensureDefaultSeries(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        invoiceType: 'F2',
        simplifiedJustification: 'transport',
        items: [
          {
            description: 'Servicio transporte',
            quantity: 1,
            unitPrice: 500,
            taxRate: 0,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.invoiceType).toBe('F2');
    expect(res.body.customerId).toBeNull();
    expect(Number(res.body.total)).toBeCloseTo(500, 2);
    // La justificacion queda trazable como prefijo en `notes` (no tenemos
    // columna dedicada). Es un detalle de implementacion del MVP.
    expect(res.body.notes).toMatch(/^\[F2:transport\]/);
  });

  it('rechaza F2 con total 3500 EUR aun con justificacion (>3000 EUR)', async () => {
    const owner = await registerVerifiedUser(app, 'f2-overmax');
    await ensureDefaultSeries(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        invoiceType: 'F2',
        simplifiedJustification: 'other',
        items: [
          {
            description: 'Articulo',
            quantity: 1,
            unitPrice: 3500,
            taxRate: 0,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('f2_amount_limit_exceeded');
  });

  it('issue de F2 sin customer asigna numero, hash y aeatStatus pendiente', async () => {
    const owner = await registerVerifiedUser(app, 'f2-issue');
    await ensureDefaultSeries(app, owner.accessToken);

    const created = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        invoiceType: 'F2',
        items: [
          {
            description: 'Llaves duplicadas',
            quantity: 2,
            unitPrice: 5,
            taxRate: 21,
          },
        ],
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const issued = await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('issued');
    expect(issued.body.invoiceType).toBe('F2');
    expect(issued.body.customerId).toBeNull();
    expect(issued.body.invoiceNumber).toMatch(/^FA\//);
    expect(issued.body.hash).toMatch(/^[0-9a-f]{64}$/);
    // El envio AEAT es asincrono (Fase 10A.4); tras issue queda pendiente.
    expect(['pending', null]).toContain(issued.body.aeatStatus);
  });

  it('rechaza F1 sin customerId (400 customer_required)', async () => {
    const owner = await registerVerifiedUser(app, 'f1-no-customer');
    await ensureDefaultSeries(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        invoiceType: 'F1',
        items: [
          {
            description: 'Cuota mes',
            quantity: 1,
            unitPrice: 100,
            taxRate: 21,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('customer_required');
  });

  it('F1 con customerId valido sigue funcionando (no regresion)', async () => {
    const owner = await registerVerifiedUser(app, 'f1-ok');
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        invoiceType: 'F1',
        customerId,
        items: [
          {
            description: 'Cuota mes',
            quantity: 1,
            unitPrice: 80,
            taxRate: 21,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.invoiceType).toBe('F1');
    expect(res.body.customerId).toBe(customerId);
  });

  it('F1 sin invoiceType explicito (default) sigue funcionando', async () => {
    const owner = await registerVerifiedUser(app, 'f1-default');
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId,
        items: [
          {
            description: 'Cuota mes',
            quantity: 1,
            unitPrice: 90,
            taxRate: 21,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.invoiceType).toBe('F1');
  });
});
