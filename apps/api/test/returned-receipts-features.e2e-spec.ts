import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { InvoiceDto, ReturnedReceiptsDto } from '@storageos/shared';

/**
 * Mejoras de Recibos devueltos: devolver a mano un cobro por banco con su
 * código, reincidentes (2 o más devoluciones en un año) y gastos por recibo
 * devuelto como factura aparte, una por devolución.
 */
describe('Recibos devueltos: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  /** Factura cobrada por transferencia: devuelve la factura y el cobro. */
  async function paidByTransfer(customerId: string, methodType = 'bank_transfer') {
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await http().post(`/invoices/${invoiceId}/issue`).set(auth()).expect(200);
    await http()
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType })
      .expect(200);
    const payment = await admin.payment.findFirstOrThrow({ where: { invoiceId } });
    return { invoiceId, paymentId: payment.id };
  }

  const returns = async () =>
    (await http().get('/payments/returns').set(auth()).expect(200)).body as ReturnedReceiptsDto;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    owner = await registerVerifiedUser(app, 'retfeat');
    await ensureDefaultSeries(app, owner.accessToken);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devolución a mano con código, reincidentes y gastos por recibo devuelto', async () => {
    const customerId = await createCustomer(app, owner.accessToken);
    const first = await paidByTransfer(customerId);

    // Solo un cobro por banco: el efectivo no lo devuelve el banco.
    const cash = await paidByTransfer(customerId, 'cash');
    const notBank = await http()
      .post(`/invoices/${cash.invoiceId}/payments/${cash.paymentId}/returned`)
      .set(auth())
      .send({ returnCode: 'AM04' })
      .expect(400);
    expect(notBank.body.code).toBe('not_a_bank_payment');

    const returned = (
      await http()
        .post(`/invoices/${first.invoiceId}/payments/${first.paymentId}/returned`)
        .set(auth())
        .send({ returnCode: 'AM04' })
        .expect(200)
    ).body as InvoiceDto;
    expect(returned.amountPaid).toBe(0);
    expect(['issued', 'overdue']).toContain(returned.status);
    // Ya no cuenta: no se devuelve dos veces.
    await http()
      .post(`/invoices/${first.invoiceId}/payments/${first.paymentId}/returned`)
      .set(auth())
      .send({})
      .expect(400);

    let list = await returns();
    const item = list.items.find((i) => i.id === first.paymentId)!;
    expect(item.returnCode).toBe('AM04');
    expect(item.reason).toContain('Saldo insuficiente');
    expect(item.customerReturns12m).toBe(1);
    expect(item.chargeable).toBe(false);
    expect(item.returnFeeInvoiceId).toBeNull();
    expect(list.returnFee).toBeNull();
    expect(list.totals.repeatCustomers).toBe(0);

    // Una segunda devolución del mismo inquilino: reincidente.
    const second = await paidByTransfer(customerId);
    await http()
      .post(`/invoices/${second.invoiceId}/payments/${second.paymentId}/returned`)
      .set(auth())
      .send({ reason: 'Cuenta sin fondos' })
      .expect(200);
    list = await returns();
    expect(list.items.filter((i) => i.customerId === customerId)).toHaveLength(2);
    expect(list.items.every((i) => i.customerReturns12m === 2)).toBe(true);
    expect(list.totals.repeatCustomers).toBe(1);

    // Gastos por recibo devuelto: hacen falta en la plantilla del contrato.
    const noFee = await http()
      .post(`/invoices/${first.invoiceId}/return-fee`)
      .set(auth())
      .send({ sourceId: first.paymentId })
      .expect(400);
    expect(noFee.body.code).toBe('no_return_fee');
    await http()
      .patch('/settings/tenant/contract-template')
      .set(auth())
      .send({ returnedPaymentFee: 5 })
      .expect(200);
    const fee = (
      await http()
        .post(`/invoices/${first.invoiceId}/return-fee`)
        .set(auth())
        .send({ sourceId: first.paymentId })
        .expect(200)
    ).body as InvoiceDto;
    expect(fee.total).toBe(5);
    expect(fee.status).toBe('issued');
    expect(fee.items[0]?.description).toContain('Gastos por recibo devuelto');
    const again = await http()
      .post(`/invoices/${first.invoiceId}/return-fee`)
      .set(auth())
      .send({ sourceId: first.paymentId })
      .expect(409);
    expect(again.body.code).toBe('return_fee_already_applied');
    // Una devolución que no es de esa factura.
    await http()
      .post(`/invoices/${first.invoiceId}/return-fee`)
      .set(auth())
      .send({ sourceId: second.paymentId })
      .expect(404);

    list = await returns();
    expect(list.returnFee).toBe(5);
    expect(list.items.find((i) => i.id === first.paymentId)?.returnFeeInvoiceId).toBe(fee.id);
  });
});
