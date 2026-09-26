import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Las comunicaciones quedan vinculadas a la factura/contrato que las originó:
 * el historial enlaza a esos recursos y se puede filtrar por ellos.
 */
describe('Comunicaciones vinculadas a factura/contrato (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un recordatorio de factura lleva invoiceId + número y se filtra por factura', async () => {
    const owner = await registerVerifiedUser(app, 'comm-links');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .post('/invoices/bulk/remind')
      .set(auth)
      .send({ ids: [invoiceId] })
      .expect(200);

    const byInvoice = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${invoiceId}`)
      .set(auth)
      .expect(200);
    const items = (byInvoice.body.items ?? byInvoice.body) as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      invoiceId,
      invoiceNumber: issued.body.invoiceNumber,
      customerId,
    });

    // Otra factura sin comunicaciones → filtro vacío.
    const other = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 10 });
    const empty = await request(app.getHttpServer())
      .get(`/communications?invoiceId=${other}`)
      .set(auth)
      .expect(200);
    expect(((empty.body.items ?? empty.body) as unknown[]).length).toBe(0);
  });

  it('un id de filtro que no es UUID responde 400', async () => {
    const owner = await registerVerifiedUser(app, 'comm-links-bad');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .get('/communications?contractId=no-es-uuid')
      .set(auth)
      .expect(400);
  });
});
