import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Segunda auditoría de facturación (PR 1): rectificativas en serie propia,
 * redondeo simétrico, abonos que compensan el pendiente, reembolso limitado al
 * dinero cobrado y sin abono doble.
 */
describe('Facturación: segunda auditoría (e2e)', () => {
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

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const issued = async (unitPrice: number) => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
      await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
      return id;
    };
    const credit = async (id: string, unitPrice: number) => {
      const r = await http()
        .post(`/invoices/${id}/rectify`)
        .set(auth)
        .send({
          rectificationType: 'R4',
          reason: 'Abono',
          items: [{ description: 'Abono', quantity: 1, unitPrice, taxRate: 21 }],
        })
        .expect(201);
      await http().post(`/invoices/${r.body.id}/issue`).set(auth).expect(200);
      return admin.invoice.findUniqueOrThrow({
        where: { id: r.body.id as string },
        include: { series: true },
      });
    };
    return { owner, auth, issued, credit };
  }

  it('las rectificativas van en su propia serie y anular deja la factura exactamente a cero', async () => {
    const { auth, issued } = await setup('aud2series');
    // 50,50 € × 21 % = 10,605 → con el redondeo antiguo el abono salía 1 céntimo distinto.
    const id = await issued(50.5);
    const original = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(Number(original.taxAmount)).toBe(10.61);

    const res = await http().post(`/invoices/${id}/cancel`).set(auth).send({ reason: 'Error' });
    expect(res.status).toBe(200);
    const rect = await admin.invoice.findUniqueOrThrow({
      where: { id: res.body.rectifiedBy[0].id as string },
      include: { series: true },
    });
    expect(rect.series.isRectification).toBe(true);
    expect(rect.seriesId).not.toBe(original.seriesId);
    expect(rect.invoiceNumber.startsWith(`${rect.series.prefix}/`)).toBe(true);
    expect(Number(rect.taxAmount)).toBe(-10.61);
    expect(Number(rect.total)).toBe(-Number(original.total));

    const today = new Date().toISOString().slice(0, 10);
    const book = await http().get(`/fiscal/vat-book?from=${today}&to=${today}`).set(auth);
    expect(book.body.totals).toMatchObject({ base: 0, vat: 0, total: 0 });

    // La serie de rectificativas no puede ser la de por defecto.
    await http()
      .patch(`/invoice-series/${rect.seriesId}`)
      .set(auth)
      .send({ isDefault: true })
      .expect(409);
  });

  it('un abono sobre una factura sin pagar compensa el pendiente y no se reclama', async () => {
    const { auth, issued, credit } = await setup('aud2comp');
    const id = await issued(100); // 121 €
    const rect = await credit(id, -50); // −60,50 €
    expect(rect.status).toBe('paid');
    expect(rect.dueDate).toBeNull();

    const original = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(Number(original.amountPaid)).toBe(60.5);
    expect(original.status).toBe('issued');
    const comp = await admin.payment.findMany({ where: { invoiceId: id } });
    expect(comp.map((p) => [p.methodType, Number(p.amount)])).toEqual([['credit_note', 60.5]]);

    // Lo cobrado no incluye la compensación.
    const rev = await http().get('/analytics/monthly-revenue?months=1').set(auth).expect(200);
    expect(rev.body.points.at(-1).collected).toBe(0);

    // Se cobra el resto en efectivo: la factura queda pagada.
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 60.5, methodType: 'cash' })
      .expect(200);
    expect((await admin.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('paid');

    // Solo se puede devolver el dinero cobrado (60,50), no lo compensado.
    const over = await http().post(`/invoices/${id}/refund`).set(auth).send({ amount: 121 });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('over_refund');
  });

  it('reembolsar después de un abono manual no genera un segundo abono', async () => {
    const { auth, issued, credit } = await setup('aud2nodouble');
    const id = await issued(100);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    // Abono manual (p. ej. el de la baja de un prepago) sobre la factura pagada.
    await credit(id, -50);
    // Y después se devuelve ese dinero.
    await http().post(`/invoices/${id}/refund`).set(auth).send({ amount: 60.5 }).expect(200);
    await new Promise((r) => setTimeout(r, 1500));
    const credits = await admin.invoice.findMany({ where: { rectifiesInvoiceId: id } });
    expect(credits).toHaveLength(1);

    // Un segundo reembolso sí genera su abono (el primero ya estaba cubierto).
    await http().post(`/invoices/${id}/refund`).set(auth).send({ amount: 30.25 }).expect(200);
    let count = 1;
    for (let i = 0; i < 30 && count < 2; i++) {
      count = await admin.invoice.count({
        where: { rectifiesInvoiceId: id, status: { not: 'draft' } },
      });
      if (count < 2) await new Promise((r) => setTimeout(r, 150));
    }
    expect(count).toBe(2);
    const last = await admin.invoice.findFirstOrThrow({
      where: { rectifiesInvoiceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(Number(last.total)).toBe(-30.25);
  });
});
