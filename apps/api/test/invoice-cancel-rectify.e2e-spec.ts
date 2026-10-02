import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Anular una factura: un borrador se cancela; una emitida se anula con una
 * rectificativa de abono por el total (emitida y compensada) y sigue
 * contando en los informes fiscales.
 */
describe('Anular factura emitida → rectificativa de abono (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let token: string;
  let customerId: string;

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function issued(unitPrice = 100): Promise<string> {
    const id = await createDraftInvoice(app, token, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    const owner = await registerVerifiedUser(app, 'cancelrect');
    token = owner.accessToken;
    customerId = await createCustomer(app, token);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un borrador se cancela sin rectificativa', async () => {
    const id = await createDraftInvoice(app, token, customerId);
    const res = await http()
      .post(`/invoices/${id}/cancel`)
      .set(auth())
      .send({ reason: 'Error' })
      .expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.rectifiedBy).toEqual([]);
  });

  it('una emitida se anula con una rectificativa de abono emitida y compensada', async () => {
    const id = await issued(100);
    const original = await admin.invoice.findUniqueOrThrow({ where: { id } });

    const res = await http()
      .post(`/invoices/${id}/cancel`)
      .set(auth())
      .send({ reason: 'Reserva no pagada' })
      .expect(200);
    expect(res.body.status).toBe('rectified');
    expect(res.body.rectifiedBy).toHaveLength(1);

    const rect = await admin.invoice.findUniqueOrThrow({
      where: { id: res.body.rectifiedBy[0].id },
      include: { items: true },
    });
    expect(rect.invoiceType).toBe('R4');
    expect(rect.rectifiesInvoiceId).toBe(id);
    expect(rect.correctionMethod).toBe('by_differences');
    expect(rect.sequenceNumber).toBeGreaterThan(0); // emitida, con número
    expect(Number(rect.total)).toBe(-Number(original.total));
    expect(Number(rect.taxAmount)).toBe(-Number(original.taxAmount));
    // Compensada: no queda pendiente ni vence.
    expect(rect.status).toBe('paid');
    expect(Number(rect.amountPaid)).toBe(Number(rect.total));
    expect(rect.dueDate).toBeNull();

    // La original ya no se cobra.
    const pay = await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash' })
      .expect(400);
    expect(pay.body.code).toBe('invoice_not_payable');

    // Sigue en el libro de IVA y la rectificativa resta: base neta 0.
    const year = new Date().getUTCFullYear();
    const book = await http()
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(auth())
      .expect(200);
    const numbers = (book.body.rows as { invoiceNumber: string }[]).map((r) => r.invoiceNumber);
    expect(numbers).toEqual(expect.arrayContaining([original.invoiceNumber, rect.invoiceNumber]));

    // No se anula dos veces ni se rectifica a mano otra vez.
    const again = await http().post(`/invoices/${id}/cancel`).set(auth()).send({}).expect(400);
    expect(again.body.code).toBe('invoice_not_cancellable');
    await http()
      .post(`/invoices/${id}/rectify`)
      .set(auth())
      .send({
        rectificationType: 'R1',
        reason: 'x',
        items: [{ description: 'x', quantity: 1, unitPrice: -1, taxRate: 21 }],
      })
      .expect(400);
  });

  it('una simplificada se anula con R5', async () => {
    const draft = await http()
      .post('/invoices')
      .set(auth())
      .send({
        invoiceType: 'F2',
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${draft.body.id}/issue`).set(auth()).expect(200);
    const res = await http()
      .post(`/invoices/${draft.body.id}/cancel`)
      .set(auth())
      .send({})
      .expect(200);
    const rect = await admin.invoice.findUniqueOrThrow({
      where: { id: res.body.rectifiedBy[0].id },
    });
    expect(rect.invoiceType).toBe('R5');
  });

  it('con cobros no se anula; dos anulaciones a la vez emiten una sola rectificativa', async () => {
    const paidPart = await issued(100);
    await http()
      .post(`/invoices/${paidPart}/mark-paid`)
      .set(auth())
      .send({ amount: 50, methodType: 'cash' })
      .expect(200);
    const blocked = await http()
      .post(`/invoices/${paidPart}/cancel`)
      .set(auth())
      .send({})
      .expect(400);
    expect(blocked.body.code).toBe('invoice_has_payments');

    const id = await issued(80);
    const results = await Promise.all([
      http().post(`/invoices/${id}/cancel`).set(auth()).send({}),
      http().post(`/invoices/${id}/cancel`).set(auth()).send({}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await admin.invoice.count({ where: { rectifiesInvoiceId: id } })).toBe(1);
  });
});
