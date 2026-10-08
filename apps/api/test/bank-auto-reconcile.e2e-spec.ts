import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { buildN43 } from './helpers/n43';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Conciliación N43 automática (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('concilia solo la coincidencia única, se puede deshacer y respeta el ajuste', async () => {
    const owner = await registerVerifiedUser(app, 'autorec');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const issue = async () => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
      const res = await request(app.getHttpServer())
        .post(`/invoices/${id}/issue`)
        .set(auth)
        .expect(200);
      return { id, number: res.body.invoiceNumber as string };
    };
    const inv1 = await issue();
    const inv2 = await issue();
    const importFile = (content: string) =>
      request(app.getHttpServer())
        .post('/bank-statements/import')
        .set(auth)
        .send({ filename: 'extracto.n43', content });

    // Desactivada (por defecto): no concilia nada solo.
    expect(
      (await request(app.getHttpServer()).get('/bank-statements/settings').set(auth)).body,
    ).toEqual({ autoReconcile: false });
    const off = await importFile(buildN43('00000000012100', inv1.number));
    expect(off.body.autoMatchedCount).toBe(0);

    await request(app.getHttpServer())
      .put('/bank-statements/settings')
      .set(auth)
      .send({ autoReconcile: true })
      .expect(200);

    // Con número de factura e importe exacto → automática.
    const on = await importFile(buildN43('00000000012100', inv1.number));
    expect(on.body.autoMatchedCount).toBe(1);
    const stId = on.body.statements[0].id as string;
    const detail = await request(app.getHttpServer()).get(`/bank-statements/${stId}`).set(auth);
    const credit = detail.body.transactions.find((t: { type: string }) => t.type === 'credit');
    expect(credit).toMatchObject({
      status: 'matched',
      autoMatched: true,
      matchedInvoiceId: inv1.id,
    });
    expect(
      (await request(app.getHttpServer()).get(`/invoices/${inv1.id}`).set(auth)).body.status,
    ).toBe('paid');

    // Mismo importe sin número: dos facturas posibles → a mano.
    const ambiguous = await importFile(buildN43('00000000012100', 'TRANSFERENCIA'));
    expect(ambiguous.body.autoMatchedCount).toBe(0);
    expect(
      (await request(app.getHttpServer()).get(`/invoices/${inv2.id}`).set(auth)).body.status,
    ).toBe('issued');

    // Deshacer: la factura vuelve a pendiente y no cuenta como recibo devuelto.
    const undo = await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${credit.id}/undo`)
      .set(auth);
    expect(undo.status).toBe(200);
    const undone = undo.body.transactions.find((t: { id: string }) => t.id === credit.id);
    expect(undone).toMatchObject({ status: 'pending', autoMatched: false });
    const after = await request(app.getHttpServer()).get(`/invoices/${inv1.id}`).set(auth);
    expect(after.body.status).toBe('issued');
    expect(after.body.amountPaid).toBe(0);
    const returns = await request(app.getHttpServer()).get('/payments/returns').set(auth);
    expect(returns.body.totals.count).toBe(0);

    // Un apunte conciliado a mano no se «deshace» por esta vía.
    await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${credit.id}/undo`)
      .set(auth)
      .expect(400);
  });
});
