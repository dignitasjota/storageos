import ExcelJS from 'exceljs';
import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** DNI con su letra de control. */
function dni(seed: number): string {
  const n = 30_000_000 + seed;
  return `${n}${'TRWAGMYFPDXBNJZSQVHLCKE'[n % 23]}`;
}

const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

/** Año y trimestre de hoy (hora de España) y el primer día del trimestre anterior. */
function quarters() {
  const today = madridToday();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const quarter = Math.floor(month / 3) + 1;
  const prevYear = quarter === 1 ? year - 1 : year;
  const prevQuarter = quarter === 1 ? 4 : quarter - 1;
  const prevStart = `${prevYear}-${String((prevQuarter - 1) * 3 + 1).padStart(2, '0')}-01`;
  const from = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
  return { today, year, quarter, prevYear, prevQuarter, prevStart, from, to: lastDay };
}

/**
 * Fiscalidad (PR B): libro de facturas recibidas, 303 con el IVA deducible, 347
 * con proveedores y efectivo, retenciones (111 y 115), «Antes de presentar»,
 * cierre del trimestre y envío a la asesoría.
 */
describe('Fiscalidad: libros, modelos, cierre y asesoría (e2e)', () => {
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

  async function owner(suffix: string) {
    const o = await registerVerifiedUser(app, suffix);
    await ensureDefaultSeries(app, o.accessToken);
    return { ...o, auth: { Authorization: `Bearer ${o.accessToken}` } };
  }

  async function issue(auth: Record<string, string>, body: Record<string, unknown>) {
    const draft = await http().post('/invoices').set(auth).send(body).expect(201);
    const res = await http()
      .post(`/invoices/${draft.body.id}/issue`)
      .set(auth)
      .send({})
      .expect(200);
    return res.body as { id: string; invoiceNumber: string; total: string };
  }

  async function expense(auth: Record<string, string>, body: Record<string, unknown>) {
    const res = await http()
      .post('/expenses')
      .set(auth)
      .send({ category: 'other', ...body })
      .expect(201);
    return res.body as { id: string };
  }

  it('el libro de recibidas, el 303 con lo deducible y las retenciones del trimestre', async () => {
    const o = await owner('fiscbooks');
    const q = quarters();
    const customerId = await createCustomer(app, o.accessToken, { documentNumber: dni(1) });
    await issue(o.auth, {
      customerId,
      items: [{ description: 'Cuota', quantity: 1, unitPrice: 100, taxRate: 21 }],
    });
    await expense(o.auth, {
      description: 'Limpieza',
      expenseDate: q.today,
      baseAmount: 50,
      vatRate: 21,
      vendor: 'Limpiezas SL',
      vendorTaxId: 'B12345674',
      invoiceNumber: 'L-1',
    });
    await expense(o.auth, {
      description: 'Asesoría',
      expenseDate: q.today,
      baseAmount: 100,
      vatRate: 21,
      withholdingRate: 15,
      withholdingModel: '111',
      vendor: 'Gestoría Pérez',
      vendorTaxId: dni(2),
    });
    await expense(o.auth, {
      description: 'Alquiler de la nave',
      expenseDate: q.today,
      baseAmount: 1000,
      vatRate: 21,
      vatDeductible: false,
      withholdingRate: 19,
      withholdingModel: '115',
      vendor: 'Inmuebles SA',
      vendorTaxId: 'A58818501',
    });
    await expense(o.auth, { description: 'Café', expenseDate: q.today, amount: 30 });

    const book = await http()
      .get(`/fiscal/received-book?from=${q.from}&to=${q.to}`)
      .set(o.auth)
      .expect(200);
    expect(book.body.rows).toHaveLength(3);
    expect(book.body.totals).toMatchObject({
      base: 1150,
      vat: 241.5,
      deductibleVat: 31.5,
      withholding: 205,
    });
    expect(book.body.unbroken).toEqual({ count: 1, amount: 30 });
    expect(book.body.byRate).toEqual([{ rate: 21, base: 150, vat: 31.5 }]);

    const m303 = await http()
      .get(`/fiscal/model-303?year=${q.year}&quarter=${q.quarter}`)
      .set(o.auth)
      .expect(200);
    expect(m303.body.totalVat).toBe(21);
    expect(m303.body.received).toMatchObject({ base: 150, vat: 31.5, count: 2 });
    expect(m303.body.unbroken).toEqual({ count: 1, amount: 30 });
    expect(m303.body.result).toBe(-10.5);

    const wh = await http()
      .get(`/fiscal/withholdings?year=${q.year}&quarter=${q.quarter}`)
      .set(o.auth)
      .expect(200);
    const byModel = Object.fromEntries(
      (wh.body.models as { model: string; amount: number; base: number }[]).map((m) => [
        m.model,
        m,
      ]),
    );
    expect(byModel['111']).toMatchObject({ amount: 15, base: 100 });
    expect(byModel['115']).toMatchObject({ amount: 190, base: 1000 });
    expect(wh.body.received).toEqual({ count: 0, base: 0, amount: 0 });
  });

  it('el 347 trae proveedores, el efectivo cobrado y avisa de quien no tiene NIF', async () => {
    const o = await owner('fisc347');
    const q = quarters();
    const withNif = await createCustomer(app, o.accessToken, { documentNumber: dni(3) });
    const noNif = await http()
      .post('/customers')
      .set(o.auth)
      .send({ customerType: 'individual', firstName: 'Sin', lastName: 'Documento', country: 'ES' })
      .expect(201);
    const big = await issue(o.auth, {
      customerId: withNif,
      items: [{ description: 'Cuota anual', quantity: 1, unitPrice: 3000, taxRate: 21 }],
    });
    await http()
      .post(`/invoices/${big.id}/mark-paid`)
      .set(o.auth)
      .send({ amount: 3630, methodType: 'cash' })
      .expect(200);
    await issue(o.auth, {
      customerId: noNif.body.id,
      items: [{ description: 'Cuota anual', quantity: 1, unitPrice: 3000, taxRate: 21 }],
    });
    await expense(o.auth, {
      description: 'Obras',
      expenseDate: q.today,
      baseAmount: 3000,
      vatRate: 21,
      vendor: 'Reformas SL',
      vendorTaxId: 'B76543214',
    });
    // Con retención: va al 190/180, no al 347.
    await expense(o.auth, {
      description: 'Alquiler',
      expenseDate: q.today,
      baseAmount: 4000,
      vatRate: 21,
      withholdingRate: 19,
      withholdingModel: '115',
      vendor: 'Inmuebles SA',
      vendorTaxId: 'A58818501',
    });
    await expense(o.auth, {
      description: 'Puertas',
      expenseDate: q.today,
      baseAmount: 3000,
      vatRate: 21,
      vendor: 'Sin Nif SA',
    });

    const res = await http().get(`/fiscal/model-347?year=${q.year}`).set(o.auth).expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ total: 3630, cash: 3630 });
    expect(res.body.suppliers).toEqual([
      expect.objectContaining({ supplierName: 'Reformas SL', nif: 'B76543214', total: 3630 }),
    ]);
    const missing = res.body.withoutNif as { name: string; kind: string; total: number }[];
    expect(missing).toHaveLength(2);
    expect(missing.find((m) => m.kind === 'customer')?.total).toBe(3630);
    expect(missing.find((m) => m.kind === 'supplier')?.name).toBe('Sin Nif SA');
  });

  it('«Antes de presentar» avisa y el trimestre cerrado no deja cambiar lo declarado', async () => {
    const o = await owner('fiscclose');
    const q = quarters();
    const noNif = await http()
      .post('/customers')
      .set(o.auth)
      .send({ customerType: 'individual', firstName: 'Sin', lastName: 'Nif', country: 'ES' })
      .expect(201);
    const inv = await issue(o.auth, {
      customerId: noNif.body.id,
      items: [{ description: 'Cuota', quantity: 1, unitPrice: 50, taxRate: 21 }],
    });

    const current = await http()
      .get(`/fiscal/checks?year=${q.year}&quarter=${q.quarter}`)
      .set(o.auth)
      .expect(200);
    expect(current.body.ended).toBe(false);
    const byKey = (body: { checks: { key: string; count: number }[] }, key: string) =>
      body.checks.find((c) => c.key === key)?.count;
    expect(byKey(current.body, 'invoices_without_nif')).toBe(1);
    await http()
      .post('/fiscal/closures')
      .set(o.auth)
      .send({ year: q.year, quarter: q.quarter })
      .expect(400);

    // Trimestre anterior: un gasto sin desglosar y otro sin NIF del proveedor.
    const old = await expense(o.auth, { description: 'Luz', expenseDate: q.prevStart, amount: 40 });
    await expense(o.auth, {
      description: 'Material',
      expenseDate: q.prevStart,
      baseAmount: 10,
      vatRate: 21,
    });
    const prev = await http()
      .get(`/fiscal/checks?year=${q.prevYear}&quarter=${q.prevQuarter}`)
      .set(o.auth)
      .expect(200);
    expect(prev.body.ended).toBe(true);
    expect(byKey(prev.body, 'expenses_unbroken')).toBe(1);
    expect(byKey(prev.body, 'expenses_without_nif')).toBe(1);
    expect(prev.body.closure).toBeNull();

    const closed = await http()
      .post('/fiscal/closures')
      .set(o.auth)
      .send({ year: q.prevYear, quarter: q.prevQuarter })
      .expect(201);
    expect(closed.body.snapshot).toMatchObject({ vatDeductible: 2.1, expenseCount: 2 });
    await http()
      .post('/fiscal/closures')
      .set(o.auth)
      .send({ year: q.prevYear, quarter: q.prevQuarter })
      .expect(409);

    // Lo declarado no se toca; lo demás (notas, pago) sí.
    const blocked = await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Tarde', expenseDate: q.prevStart, amount: 5 })
      .expect(409);
    expect(blocked.body.code).toBe('fiscal_period_closed');
    await http().patch(`/expenses/${old.id}`).set(o.auth).send({ amount: 41 }).expect(409);
    await http().patch(`/expenses/${old.id}`).set(o.auth).send({ notes: 'Pagada' }).expect(200);
    await http().delete(`/expenses/${old.id}`).set(o.auth).expect(409);
    const preview = await http()
      .post('/imports/expenses/preview')
      .set(o.auth)
      .send({ csv: `fecha;concepto;importe\n${q.prevStart};Agua;12` })
      .expect(201);
    expect(preview.body.rows[0].status).toBe('error');

    // Anular por error una factura de ese trimestre: con una rectificativa.
    await admin.invoice.update({
      where: { id: inv.id },
      data: { issueDate: new Date(`${q.prevStart}T00:00:00Z`) },
    });
    const voided = await http()
      .post(`/invoices/${inv.id}/void`)
      .set(o.auth)
      .send({ reason: 'Emitida por error' })
      .expect(409);
    expect(voided.body.code).toBe('fiscal_period_closed');

    // Reabrir (propietario) vuelve a dejarlo cambiar.
    await http()
      .post(`/fiscal/closures/${closed.body.id}/reopen`)
      .set(o.auth)
      .send({ reason: 'Faltaba una factura' })
      .expect(200);
    await http()
      .post(`/fiscal/closures/${closed.body.id}/reopen`)
      .set(o.auth)
      .send({ reason: 'Otra vez' })
      .expect(404);
    await expense(o.auth, { description: 'Tarde', expenseDate: q.prevStart, amount: 5 });
    const list = await http().get('/fiscal/closures').set(o.auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].reopenReason).toBe('Faltaba una factura');
  });

  it('la exportación lleva los gastos y se envía a la asesoría con un enlace', async () => {
    const o = await owner('fiscacct');
    const q = quarters();
    await expense(o.auth, {
      description: 'Seguro del local',
      expenseDate: q.today,
      baseAmount: 200,
      vatRate: 0,
      vendor: 'Seguros SA',
      vendorTaxId: 'A28007748',
      paymentStatus: 'paid',
      paidAt: q.today,
      paymentMethod: 'direct_debit',
    });

    const json = await http()
      .get(`/fiscal/accountant-export?from=${q.from}&to=${q.to}`)
      .set(o.auth)
      .expect(200);
    expect(json.body.expenses).toEqual([
      expect.objectContaining({ vendorName: 'Seguros SA', base: 200, total: 200 }),
    ]);
    const csv = await http()
      .get(`/fiscal/accountant-export?from=${q.from}&to=${q.to}&format=csv&kind=expenses`)
      .set(o.auth)
      .expect(200);
    expect(csv.text).toContain('NIF proveedor');
    expect(csv.text).toContain('Seguros SA');
    const xlsx = await http()
      .get(`/fiscal/accountant-export?from=${q.from}&to=${q.to}&format=xlsx`)
      .set(o.auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Facturas', 'Cobros', 'Fianzas', 'Gastos']);

    const bad = await http()
      .put('/fiscal/accountant')
      .set(o.auth)
      .send({ email: '', frequency: 'monthly' })
      .expect(400);
    expect(bad.body.code).toBe('accountant_email_required');
    const email = `asesoria-${Date.now().toString(36)}@e2e.local`;
    const saved = await http()
      .put('/fiscal/accountant')
      .set(o.auth)
      .send({ email, frequency: 'quarterly' })
      .expect(200);
    expect(saved.body).toEqual({ email, frequency: 'quarterly', lastPeriod: null });

    const sent = await http()
      .post('/fiscal/accountant/send')
      .set(o.auth)
      .send({ from: q.from, to: q.to })
      .expect(200);
    expect(sent.body.sentTo).toBe(email);
    const msg = await waitForEmail(email, { subjectIncludes: 'Documentación contable' });
    const link = /\/v1\/public\/accountant-reports\/([\w.-]+)/.exec(msg.Text ?? msg.HTML ?? '');
    expect(link).not.toBeNull();
    const download = await http().get(`/public/accountant-reports/${link![1]}`).expect(302);
    expect(download.headers.location).toContain('/accountant/');
    await http().get(`/public/accountant-reports/${link![1]}x`).expect(404);
  });
});
