import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Rectificativas y reembolsos: reembolsar emite el abono; los abonos no
 * superan la factura; la sustitución no duplica la base; las métricas
 * descuentan lo devuelto.
 */
describe('Rectificativas netas y abono por reembolso (e2e)', () => {
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
    const issued = async (unitPrice = 100) => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
      await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
      return id;
    };
    return { owner, auth, issued };
  }

  const today = () => new Date().toISOString().slice(0, 10);

  async function creditNotes(originalId: string, expected: number) {
    for (let i = 0; i < 40; i++) {
      const rows = await admin.invoice.findMany({
        where: { rectifiesInvoiceId: originalId },
        orderBy: { createdAt: 'asc' },
      });
      if (rows.length >= expected && rows.every((r) => r.status !== 'draft')) return rows;
      await new Promise((r) => setTimeout(r, 150));
    }
    return admin.invoice.findMany({ where: { rectifiesInvoiceId: originalId } });
  }

  it('reembolsar emite una rectificativa de abono por lo devuelto', async () => {
    const { auth, issued } = await setup('rfcredit');
    const id = await issued(100); // 121 con IVA
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await http().post(`/invoices/${id}/refund`).set(auth).send({ amount: 60.5 }).expect(200);

    const [credit] = await creditNotes(id, 1);
    expect(credit).toBeDefined();
    expect(credit!.invoiceType).toBe('R4');
    expect(credit!.correctionMethod).toBe('by_differences');
    expect(Number(credit!.total)).toBe(-60.5);
    expect(Number(credit!.subtotal)).toBe(-50);
    expect(credit!.status).toBe('paid'); // compensada: el dinero ya se devolvió

    // Libro de IVA neto: 100 de base − 50 abonados.
    const book = await http()
      .get(`/fiscal/vat-book?from=${today()}&to=${today()}`)
      .set(auth)
      .expect(200);
    expect(book.body.totals.base).toBe(50);
    expect(book.body.totals.vat).toBe(10.5);

    // Métricas: lo cobrado y lo facturado descuentan lo devuelto.
    const rev = await http().get('/analytics/monthly-revenue?months=1').set(auth).expect(200);
    const point = rev.body.points.at(-1);
    expect(point.collected).toBe(60.5);
    expect(point.invoiced).toBe(60.5);

    // Los abonos no pueden superar la factura.
    const over = await http()
      .post(`/invoices/${id}/rectify`)
      .set(auth)
      .send({
        rectificationType: 'R4',
        reason: 'Abono de más',
        items: [{ description: 'x', quantity: 1, unitPrice: -60, taxRate: 21 }],
      })
      .expect(400);
    expect(over.body.code).toBe('rectification_exceeds_original');
  });

  it('la sustitución exige factura sin cobros y no duplica la base', async () => {
    const { auth, issued } = await setup('rfsubst');
    const sub = (id: string, unitPrice: number) =>
      http()
        .post(`/invoices/${id}/rectify`)
        .set(auth)
        .send({
          rectificationType: 'R1',
          reason: 'Importe corregido',
          correctionMethod: 'by_substitution',
          items: [{ description: 'Cuota corregida', quantity: 1, unitPrice, taxRate: 21 }],
        });

    // Con cobros → no se sustituye.
    const paid = await issued(100);
    await http()
      .post(`/invoices/${paid}/mark-paid`)
      .set(auth)
      .send({ amount: 50, methodType: 'cash' })
      .expect(200);
    const rejected = await sub(paid, 200).expect(400);
    expect(rejected.body.code).toBe('substitution_original_paid');

    // Sin cobros → la sustitutiva vale y la original deja de cobrarse.
    const id = await issued(100);
    const draft = await sub(id, 200).expect(201);
    await http().post(`/invoices/${draft.body.id}/issue`).set(auth).expect(200);
    const original = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(original.status).toBe('rectified');

    // Una segunda rectificativa de la sustituida → 409.
    const again = await sub(id, 150).expect(400); // la original ya está anulada
    expect(again.body.code).toBe('invoice_not_rectifiable');

    // Libro de IVA: 100 (pagada a medias) + 100 (original) + (200 − 100) = 300.
    const book = await http()
      .get(`/fiscal/vat-book?from=${today()}&to=${today()}`)
      .set(auth)
      .expect(200);
    expect(book.body.totals.base).toBe(300);
    const now = new Date();
    const q = Math.floor(now.getUTCMonth() / 3) + 1;
    const m303 = await http()
      .get(`/fiscal/model-303?year=${now.getUTCFullYear()}&quarter=${q}`)
      .set(auth)
      .expect(200);
    expect(m303.body.totalBase).toBe(300);
    expect(m303.body.totalVat).toBe(63);
  });
});
