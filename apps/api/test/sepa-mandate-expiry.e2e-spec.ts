import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { futureCollectionDate } from './helpers/platform-sepa';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Mandatos SEPA: caducidad y preaviso (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un mandato sin cobros en 36 meses caduca; la fecha de cobro respeta el preaviso', async () => {
    const owner = await registerVerifiedUser(app, 'sepaexp');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    await request(app.getHttpServer())
      .put('/sepa/settings')
      .set(auth)
      .send({
        creditorName: 'Trasteros SL',
        creditorId: 'ES97ZZZB12345678',
        creditorIban: 'ES9121000418450200051332',
        enabled: true,
      })
      .expect(200);

    // Firmado hace más de 36 meses y nunca usado → caducado.
    const oldCustomer = await createCustomer(app, owner.accessToken, {
      email: `sepaexp-old-${Date.now()}@e2e.local`,
    });
    const oldMandate = await request(app.getHttpServer())
      .post('/sepa/mandates')
      .set(auth)
      .send({
        customerId: oldCustomer,
        iban: 'ES7921000813610123456789',
        signedOutside: true,
        signedAt: '2022-01-10',
      })
      .expect(201);
    expect(oldMandate.body.expiresOn).toBe('2025-01-10');
    const oldInvoice = await createDraftInvoice(app, owner.accessToken, oldCustomer);
    await request(app.getHttpServer()).post(`/invoices/${oldInvoice}/issue`).set(auth).expect(200);

    // Firmado este año → vale.
    const newCustomer = await createCustomer(app, owner.accessToken, {
      email: `sepaexp-new-${Date.now()}@e2e.local`,
    });
    await request(app.getHttpServer())
      .post('/sepa/mandates')
      .set(auth)
      .send({
        customerId: newCustomer,
        iban: 'ES6621000418401234567891',
        signedOutside: true,
        signedAt: new Date().toISOString().slice(0, 10),
      })
      .expect(201);
    const newInvoice = await createDraftInvoice(app, owner.accessToken, newCustomer);
    await request(app.getHttpServer()).post(`/invoices/${newInvoice}/issue`).set(auth).expect(200);

    const preview = await request(app.getHttpServer()).post('/sepa/remittances/preview').set(auth);
    expect(preview.body.eligible.map((e: { invoiceId: string }) => e.invoiceId)).toEqual([
      newInvoice,
    ]);
    const without = preview.body.withoutMandate.find(
      (w: { invoiceId: string }) => w.invoiceId === oldInvoice,
    );
    expect(without.expiredMandate).toBe(true);
    const mandates = await request(app.getHttpServer())
      .get(`/sepa/mandates?customerId=${oldCustomer}`)
      .set(auth);
    expect(mandates.body[0].status).toBe('expired');

    // Preaviso de 14 días: antes → 400; con el plazo → se crea.
    const tooSoon = await request(app.getHttpServer())
      .post('/sepa/remittances')
      .set(auth)
      .send({ name: 'Pronto', collectionDate: futureCollectionDate(3), invoiceIds: [newInvoice] });
    expect(tooSoon.status).toBe(400);
    expect(['collection_date_too_soon', 'invalid_collection_date']).toContain(tooSoon.body.code);
    await request(app.getHttpServer())
      .post('/sepa/remittances')
      .set(auth)
      .send({ name: 'Bien', collectionDate: futureCollectionDate(20), invoiceIds: [newInvoice] })
      .expect(201);
  });
});
