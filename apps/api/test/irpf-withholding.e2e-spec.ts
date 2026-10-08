import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { buildN43 } from './helpers/n43';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Retención de IRPF por contrato: el total de la factura no cambia (base + IVA,
 * lo que va a Veri*Factu); lo que se cobra es el total menos la retención.
 */
describe('Retención de IRPF (e2e)', () => {
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

  it('resta la retención de lo que se cobra sin tocar el total ni el IVA', async () => {
    const owner = await registerVerifiedUser(app, 'irpf');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 100,
    });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);
    const setPct = await http()
      .put(`/contracts/${contract.body.id}/irpf-retention`)
      .set(auth)
      .send({ pct: 19 });
    expect(setPct.status).toBe(200);
    expect(setPct.body.irpfRetentionPct).toBe(19);

    // Alquiler 100 € + IVA 21 % y una fianza (no sujeta): la fianza no lleva retención.
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: contract.body.id,
        items: [
          { description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 },
          { description: 'Fianza', quantity: 1, unitPrice: 50, taxRate: 0, taxCategory: 'N1' },
        ],
      })
      .expect(201);
    const issued = await http().post(`/invoices/${draft.body.id}/issue`).set(auth).expect(200);
    expect(issued.body).toMatchObject({
      status: 'issued',
      total: 171,
      taxAmount: 21,
      withholdingPct: 19,
      withholdingAmount: 19,
      amountDue: 152,
      amountPending: 152,
    });

    // Cobrar lo que se debe la salda; la caja solo ve el dinero.
    await http()
      .post(`/invoices/${draft.body.id}/mark-paid`)
      .set(auth)
      .send({ amount: 152, methodType: 'cash' })
      .expect(200);
    const paid = await http().get(`/invoices/${draft.body.id}`).set(auth);
    expect(paid.body.status).toBe('paid');
    const today = new Date().toISOString().slice(0, 10);
    const cash = await http().get(`/cash/summary?date=${today}`).set(auth).expect(200);
    expect(cash.body.cash).toBe(152);
    expect(cash.body.total).toBe(152);

    // No se reembolsa más de lo cobrado de verdad.
    const over = await http()
      .post(`/invoices/${draft.body.id}/refund`)
      .set(auth)
      .send({ amount: 160, reason: 'prueba' });
    expect(over.status).toBe(400);

    // El IVA y la retención, a la asesoría; la retención no figura como cobro.
    const exp = await http()
      .get(`/fiscal/accountant-export?from=${today}&to=${today}`)
      .set(auth)
      .expect(200);
    const rows = exp.body.invoices as { base: number; vat: number; withholding: number }[];
    expect(rows.reduce((s, r) => s + r.withholding, 0)).toBe(19);
    expect(rows.reduce((s, r) => s + r.vat, 0)).toBe(21);
    expect(exp.body.payments).toEqual([expect.objectContaining({ amount: 152 })]);

    // Una factura con retención y sin cobros se puede anular.
    const draft2 = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: contract.body.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${draft2.body.id}/issue`).set(auth).expect(200);
    const cancel = await http().post(`/invoices/${draft2.body.id}/cancel`).set(auth).send({
      reason: 'error',
    });
    expect(cancel.status).toBeLessThan(300);

    // Sin retención en el contrato: nada cambia.
    const plain = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[1],
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    await http().post(`/contracts/${plain.body.id}/sign`).set(auth).send({}).expect(200);
    const d3 = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: plain.body.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    const i3 = await http().post(`/invoices/${d3.body.id}/issue`).set(auth).expect(200);
    expect(i3.body).toMatchObject({ withholdingAmount: 0, amountPending: 121, amountDue: 121 });
    expect(
      await admin.payment.count({ where: { invoiceId: d3.body.id, methodType: 'withholding' } }),
    ).toBe(0);
  });

  it('una devolución bancaria se sugiere y revierte por lo cobrado, no por la retención', async () => {
    const owner = await registerVerifiedUser(app, 'irpfret');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);
    await http()
      .put(`/contracts/${contract.body.id}/irpf-retention`)
      .set(auth)
      .send({ pct: 19 })
      .expect(200);
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: contract.body.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    const id = draft.body.id as string;
    // 121 € de total, 19 € retenidos: se cobran 102 € por el banco.
    await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 102, methodType: 'bank_transfer' })
      .expect(200);

    // El banco devuelve 102 € (no 121): la factura sale como sugerencia.
    const imported = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'r.n43', content: buildN43('00000000000100', 'OTRO', '00000000010200') })
      .expect(201);
    const detail = await http()
      .get(`/bank-statements/${imported.body.statements[0].id}`)
      .set(auth)
      .expect(200);
    const debit = detail.body.transactions.find((t: { type: string }) => t.type === 'debit');
    expect(debit.returnSuggestions.map((x: { invoiceId: string }) => x.invoiceId)).toContain(id);

    await http()
      .post(`/bank-statements/transactions/${debit.id}/mark-return`)
      .set(auth)
      .send({ invoiceId: id })
      .expect(200);
    // Vuelve a deber los 102 €; la retención sigue aplicada.
    const after = await http().get(`/invoices/${id}`).set(auth).expect(200);
    expect(after.body).toMatchObject({ amountPaid: 19, amountPending: 102, withholdingAmount: 19 });
    expect(after.body.status).not.toBe('paid');
  });
});
