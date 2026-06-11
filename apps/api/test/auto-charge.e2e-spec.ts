import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Auto-charge al emitir factura. Sin claves Stripe en test, el e2e cubre:
 * el endpoint de settings (GET/PATCH owner + 401 sin auth) y que con el
 * flag activo la emision de una factura de un customer SIN metodo de pago
 * hace skip limpio (la factura queda issued, nada revienta). El cobro real
 * se valida a mano en Stripe test mode (DEPLOYMENT.md 12B).
 */
describe('Auto-charge on issue (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('GET/PATCH /settings/tenant/billing: owner lee y muta el flag; sin auth 401', async () => {
    const owner = await registerVerifiedUser(app, 'autochg-settings');

    const initial = await request(app.getHttpServer())
      .get('/settings/tenant/billing')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ autoChargeOnIssue: false });

    const enable = await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ autoChargeOnIssue: true });
    expect(enable.status).toBe(200);
    expect(enable.body).toEqual({ autoChargeOnIssue: true });

    const after = await request(app.getHttpServer())
      .get('/settings/tenant/billing')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(after.body).toEqual({ autoChargeOnIssue: true });

    const sinAuth = await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .send({ autoChargeOnIssue: false });
    expect(sinAuth.status).toBe(401);
  });

  it('con flag activo, emitir factura de customer sin PM hace skip limpio (queda issued)', async () => {
    const owner = await registerVerifiedUser(app, 'autochg-skip');
    await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ autoChargeOnIssue: true });

    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 60,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('issued');

    // El listener encola y el processor in-process hace skip (no_payment_method).
    // Polling corto: la factura debe SEGUIR issued con amountPaid 0 y sin
    // payments creados — el skip no toca nada.
    await new Promise((r) => setTimeout(r, 1500));
    const detail = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(detail.body.status).toBe('issued');
    expect(detail.body.amountPaid).toBe(0);

    const payments = await request(app.getHttpServer())
      .get(`/payments?invoiceId=${invoiceId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(payments.status).toBe(200);
    expect(payments.body).toEqual([]);
  });
});
