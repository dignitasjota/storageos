import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PaymentsService } from '../src/modules/payments/payments.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { buildN43 } from './helpers/n43';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Recibos devueltos (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('lista la devolución bancaria y el contracargo, con lo que sigue pendiente', async () => {
    const owner = await registerVerifiedUser(app, 'returns');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken, {
      firstName: 'Lucía',
      lastName: 'Devuelta',
    });

    const issue = async () => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
      const res = await request(app.getHttpServer())
        .post(`/invoices/${id}/issue`)
        .set(auth)
        .expect(200);
      return { id, number: res.body.invoiceNumber as string };
    };

    // 1) Devolución bancaria desde la conciliación N43.
    const inv1 = await issue();
    const imp1 = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'cobro.n43', content: buildN43('00000000012100', inv1.number) });
    const st1 = await request(app.getHttpServer())
      .get(`/bank-statements/${imp1.body.statements[0].id}`)
      .set(auth);
    const credit = st1.body.transactions.find((t: { type: string }) => t.type === 'credit');
    await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(auth)
      .send({ invoiceId: inv1.id })
      .expect(200);
    const imp2 = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(auth)
      .send({
        filename: 'devolucion.n43',
        content: buildN43('00000000000100', `OTRA-${inv1.number}`, '00000000012100'),
      });
    const st2 = await request(app.getHttpServer())
      .get(`/bank-statements/${imp2.body.statements[0].id}`)
      .set(auth);
    const debit = st2.body.transactions.find((t: { type: string }) => t.type === 'debit');
    await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${debit.id}/mark-return`)
      .set(auth)
      .send({ invoiceId: inv1.id })
      .expect(200);

    // 2) Contracargo de tarjeta: un cobro de Stripe cobrado que se disputa.
    const inv2 = await issue();
    await admin.$transaction([
      admin.payment.create({
        data: {
          tenantId: owner.tenantId,
          invoiceId: inv2.id,
          customerId,
          amount: 121,
          status: 'succeeded',
          methodType: 'card',
          gateway: 'stripe',
          gatewayPaymentId: `pi_returns_${owner.tenantId.slice(0, 8)}`,
          paidAt: new Date(),
        },
      }),
      admin.invoice.update({
        where: { id: inv2.id },
        data: { amountPaid: 121, status: 'paid', paidAt: new Date() },
      }),
    ]);
    await app.get(PaymentsService).syncDisputeFromWebhook({
      tenantId: owner.tenantId,
      gatewayPaymentId: `pi_returns_${owner.tenantId.slice(0, 8)}`,
      reason: 'fraudulent',
    });

    const res = await request(app.getHttpServer()).get('/payments/returns').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.totals.count).toBe(2);
    expect(res.body.totals.amount).toBe(242);
    expect(res.body.totals.stillPending).toBe(242);
    const byInvoice = new Map(
      (res.body.items as { invoiceId: string }[]).map((i) => [i.invoiceId, i]),
    );
    expect(byInvoice.get(inv1.id)).toMatchObject({
      kind: 'bank_return',
      amount: 121,
      invoiceNumber: inv1.number,
      customerName: 'Lucía Devuelta',
      invoicePending: 121,
    });
    expect(byInvoice.get(inv2.id)).toMatchObject({
      kind: 'chargeback',
      reason: 'Contracargo o devolución (fraudulent)',
    });

    // Filtro por tipo y por periodo.
    const onlyCb = await request(app.getHttpServer())
      .get('/payments/returns?kind=chargeback')
      .set(auth);
    expect(onlyCb.body.items).toHaveLength(1);
    const old = await request(app.getHttpServer())
      .get('/payments/returns?from=2020-01-01&to=2020-12-31')
      .set(auth);
    expect(old.body.totals.count).toBe(0);
  });

  it('valida los filtros y exige sesión', async () => {
    await request(app.getHttpServer()).get('/payments/returns').expect(401);
    const owner = await registerVerifiedUser(app, 'returns2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .get('/payments/returns?from=no-es-fecha')
      .set(auth)
      .expect(400);
    await request(app.getHttpServer())
      .get('/payments/returns?facilityId=xyz')
      .set(auth)
      .expect(400);
  });
});
