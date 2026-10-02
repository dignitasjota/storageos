import request from 'supertest';

import { todayInTimezone } from '../src/common/format';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { buildN43 } from './helpers/n43';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Menores de la auditoría de facturación (PR 8): fecha de emisión en la zona
 * del tenant y en orden dentro de la serie, N43 repartido entre varias
 * facturas y cobro de una F2 sin cliente con su pago.
 */
describe('Facturación: menores (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('fecha de emisión = hoy en la zona del tenant; no anterior a la última de la serie', async () => {
    const owner = await registerVerifiedUser(app, 'minordate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tz = 'Pacific/Kiritimati'; // UTC+14: casi siempre un día por delante de UTC
    await admin.tenant.update({ where: { id: owner.tenantId }, data: { timezone: tz } });
    const customerId = await createCustomer(app, owner.accessToken);

    const first = await createDraftInvoice(app, owner.accessToken, customerId);
    const issued = await http().post(`/invoices/${first}/issue`).set(auth).expect(200);
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    expect(issued.body.issueDate).toBe(today);
    expect(issued.body.invoiceNumber).toContain(`/${today.slice(0, 4)}/`);

    // Borrador con fecha anterior a la última emitida de la serie → 400.
    const series = await admin.invoice.findUniqueOrThrow({
      where: { id: first },
      select: { seriesId: true },
    });
    const back = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        seriesId: series.seriesId,
        issueDate: '2020-01-01',
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 10, taxRate: 21 }],
      });
    expect(back.status).toBe(201);
    const rejected = await http().post(`/invoices/${back.body.id}/issue`).set(auth).expect(400);
    expect(rejected.body.code).toBe('issue_date_before_last');
  });

  it('N43: un ingreso se reparte entre varias facturas', async () => {
    const owner = await registerVerifiedUser(app, 'minorn43');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const a = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    const b = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${a}/issue`).set(auth).expect(200);
    await http().post(`/invoices/${b}/issue`).set(auth).expect(200);

    // Ingreso de 100 € para dos facturas de 60,50 €.
    const imported = await http()
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'x.n43', content: buildN43('00000000010000', 'VARIAS') })
      .expect(201);
    const detail = await http().get(`/bank-statements/${imported.body.statements[0].id}`).set(auth);
    const credit = detail.body.transactions.find((t: { type: string }) => t.type === 'credit');
    await http()
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(auth)
      .send({ invoiceIds: [a, b] })
      .expect(200);

    const [ia, ib] = await Promise.all([
      admin.invoice.findUniqueOrThrow({ where: { id: a } }),
      admin.invoice.findUniqueOrThrow({ where: { id: b } }),
    ]);
    expect(ia.status).toBe('paid');
    expect(Number(ia.amountPaid)).toBe(60.5);
    expect(ib.status).not.toBe('paid');
    expect(Number(ib.amountPaid)).toBe(39.5);

    // Ni las dos facturas ni ninguna: 400.
    await http()
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(auth)
      .send({ invoiceId: a, invoiceIds: [b] })
      .expect(400);
  });

  it('F2 sin cliente cobrada a mano: crea su pago y cuenta en la caja', async () => {
    const owner = await registerVerifiedUser(app, 'minorf2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        invoiceType: 'F2',
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${draft.body.id}/issue`).set(auth).expect(200);
    await http()
      .post(`/invoices/${draft.body.id}/mark-paid`)
      .set(auth)
      .send({ amount: 12.1, methodType: 'cash' })
      .expect(200);

    const pays = await admin.payment.findMany({ where: { invoiceId: draft.body.id } });
    expect(pays).toHaveLength(1);
    expect(pays[0]!.customerId).toBeNull();

    const list = await http().get('/payments').set(auth).expect(200);
    const row = (list.body as { invoiceId: string; customerName: string }[]).find(
      (p) => p.invoiceId === draft.body.id,
    );
    expect(row?.customerName).toBe('Sin cliente (F2)');

    const day = pays[0]!.paidAt!.toISOString().slice(0, 10);
    const cash = await http().get(`/cash/summary?date=${day}`).set(auth).expect(200);
    expect(cash.body.cash).toBeGreaterThanOrEqual(12.1);
  });
});
