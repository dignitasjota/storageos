import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const shift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const shiftMonths = (day: string, months: number) => {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

/**
 * Mejoras de Gastos: desglose fiscal, proveedores, categorías propias,
 * justificante leído con IA, pago con la salida de caja, recurrentes
 * trimestrales, cuenta de resultados con reparto y presupuesto, cambios en lote
 * e importación.
 */
describe('Mejoras de Gastos (e2e)', () => {
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
    return { ...o, auth: { Authorization: `Bearer ${o.accessToken}` } };
  }

  it('desglose, proveedor y categorías propias', async () => {
    const o = await owner('expdesg');
    const today = madridToday();
    const supplier = await http()
      .post('/expense-suppliers')
      .set(o.auth)
      .send({
        name: 'Inmobiliaria Local SL',
        taxId: 'b-1234567 4',
        defaultCategory: 'rent',
        defaultVatRate: 21,
        defaultWithholdingRate: 19,
        defaultWithholdingModel: '115',
      })
      .expect(201);
    expect(supplier.body.taxId).toBe('B12345674');
    await http()
      .post('/expense-suppliers')
      .set(o.auth)
      .send({ name: 'Otro', taxId: 'B12345674' })
      .expect(409);

    // Alquiler con retención: cuesta la base, se paga base + IVA − retención.
    const rent = await http()
      .post('/expenses')
      .set(o.auth)
      .send({
        description: 'Alquiler de noviembre',
        category: 'rent',
        expenseDate: today,
        supplierId: supplier.body.id,
        invoiceNumber: 'A-11',
        baseAmount: 1000,
        vatRate: 21,
        withholdingRate: 19,
        withholdingModel: '115',
      })
      .expect(201);
    expect(rent.body).toMatchObject({
      broken: true,
      amount: 1000,
      vatAmount: 210,
      withholdingAmount: 190,
      totalAmount: 1020,
      vendor: 'Inmobiliaria Local SL',
      vendorTaxId: 'B12345674',
      supplierName: 'Inmobiliaria Local SL',
      paymentStatus: 'paid',
      paidAt: today,
    });

    // IVA que no se deduce: cuenta como gasto.
    const noDeduct = await http()
      .post('/expenses')
      .set(o.auth)
      .send({
        description: 'Comida con cliente',
        expenseDate: today,
        baseAmount: 100,
        vatRate: 10,
        vatDeductible: false,
      })
      .expect(201);
    expect(noDeduct.body.amount).toBe(110);

    // La retención necesita su modelo.
    const noModel = await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Asesoría', expenseDate: today, baseAmount: 200, withholdingRate: 15 })
      .expect(400);
    expect(noModel.body.code).toBe('withholding_model_required');

    // Categoría propia: se usa y, al borrarla, sus gastos pasan a «Otros».
    const cat = await http()
      .post('/expense-categories')
      .set(o.auth)
      .send({ name: 'Limpieza' })
      .expect(201);
    await http().post('/expense-categories').set(o.auth).send({ name: 'limpieza' }).expect(409);
    await http().post('/expense-categories').set(o.auth).send({ name: 'Alquiler' }).expect(409);
    const cleaning = await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Limpieza', category: cat.body.key, amount: 50, expenseDate: today })
      .expect(201);
    expect(cleaning.body.categoryLabel).toBe('Limpieza');
    await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'X', category: 'inventada', amount: 5, expenseDate: today })
      .expect(400);
    const removed = await http()
      .delete(`/expense-categories/${cat.body.key.slice(7)}`)
      .set(o.auth)
      .expect(200);
    expect(removed.body.moved).toBe(1);
    const after = await admin.expense.findUniqueOrThrow({ where: { id: cleaning.body.id } });
    expect(after.category).toBe('other');

    const suppliers = await http().get('/expense-suppliers').set(o.auth).expect(200);
    expect(suppliers.body[0]).toMatchObject({ expenseCount: 1, last12Months: 1000 });
  });

  it('justificante privado y lectura con IA solo con el asistente', async () => {
    const o = await owner('exprec');
    const other = await owner('exprecother');
    const today = madridToday();
    const upload = async (auth: Record<string, string>) => {
      const presign = await http()
        .post('/expenses/receipt-upload-url')
        .set(auth)
        .send({ mimeType: 'image/png' })
        .expect(201);
      await fetch(presign.body.uploadUrl as string, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: PNG,
      });
      return presign.body.key as string;
    };
    const key = await upload(o.auth);

    // Sin el asistente IA en el plan, no se lee.
    const noAi = await http().post('/expenses/receipts/read').set(o.auth).send({ key }).expect(403);
    expect(noAi.body.code).toBe('feature_not_in_plan');
    await setTenantPlan(o.slug, 'pro');
    const read = await http().post('/expenses/receipts/read').set(o.auth).send({ key }).expect(200);
    expect(read.body).toMatchObject({
      vendor: 'Suministros Demo SL',
      vendorTaxId: 'B12345674',
      baseAmount: 100,
      vatRate: 21,
      totalAmount: 121,
      category: 'supplies',
      supplierId: null,
    });

    // El de otra empresa no vale.
    const foreign = await upload(other.auth);
    await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Ajeno', amount: 1, expenseDate: today, receiptKey: foreign })
      .expect(400);

    const exp = await http()
      .post('/expenses')
      .set(o.auth)
      .send({
        description: 'Material',
        expenseDate: today,
        baseAmount: 100,
        vatRate: 21,
        receiptKey: key,
        receiptName: 'factura.png',
        receiptMime: 'image/png',
      })
      .expect(201);
    expect(exp.body.hasReceipt).toBe(true);
    const url = await http().get(`/expenses/${exp.body.id}/receipt`).set(o.auth).expect(200);
    expect(url.body.url).toContain('factura.png');
  });

  it('pago en efectivo: salida de caja, vencidos en «Hoy» y caja cerrada', async () => {
    const o = await owner('exppay');
    const today = madridToday();
    const pending = await http()
      .post('/expenses')
      .set(o.auth)
      .send({
        description: 'Reparación de la persiana',
        expenseDate: shift(today, -10),
        amount: 80,
        paymentStatus: 'pending',
        dueDate: shift(today, -2),
      })
      .expect(201);
    expect(pending.body).toMatchObject({ paymentStatus: 'pending', paidAt: null, overdue: true });

    const todayRes = await http().get('/dashboard/today').set(o.auth).expect(200);
    expect(todayRes.body.expensesToPay.count).toBe(1);
    expect(todayRes.body.expensesToPay.items[0]).toMatchObject({
      id: pending.body.id,
      overdue: true,
    });
    const total = await http().get('/expenses/total').set(o.auth).expect(200);
    expect(total.body).toMatchObject({ count: 1, amount: 80, pending: 80 });
    const overdue = await http().get('/expenses?paymentStatus=overdue').set(o.auth).expect(200);
    expect(overdue.body).toHaveLength(1);

    // Pagado en efectivo hoy: sale de la caja global.
    const paid = await http()
      .post(`/expenses/${pending.body.id}/mark-paid`)
      .set(o.auth)
      .send({ paidAt: today, paymentMethod: 'cash' })
      .expect(200);
    expect(paid.body.cashMovementId).toBeTruthy();
    const summary = await http().get(`/cash/summary?date=${today}`).set(o.auth).expect(200);
    const movement = (
      summary.body.movements as { id: string; kind: string; amount: number }[]
    ).find((m) => m.id === paid.body.cashMovementId);
    expect(movement).toMatchObject({ kind: 'expense_payment', amount: 80 });
    const blocked = await http()
      .delete(`/cash/movements/${paid.body.cashMovementId}`)
      .set(o.auth)
      .expect(409);
    expect(blocked.body.code).toBe('movement_from_expense');

    // Vuelve a pendiente: la salida desaparece.
    await http().post(`/expenses/${pending.body.id}/mark-pending`).set(o.auth).expect(200);
    expect(await admin.cashMovement.count({ where: { id: paid.body.cashMovementId } })).toBe(0);

    // Con la caja de hoy cerrada no se apunta y se avisa.
    await http()
      .post('/cash/close')
      .set(o.auth)
      .send({ date: today, countedCash: 0 })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const late = await http()
      .post(`/expenses/${pending.body.id}/mark-paid`)
      .set(o.auth)
      .send({ paidAt: today, paymentMethod: 'cash' })
      .expect(200);
    expect(late.body.cashMovementId).toBeNull();
    expect(late.body.cashNotice).toMatch(/cerrada/);
  });

  it('recurrentes trimestrales: fechas pendientes, recuperación y pendiente de pago', async () => {
    const o = await owner('exprec3');
    const today = madridToday();
    const start = shiftMonths(today, -6);
    const tpl = await http()
      .post('/expenses/recurring')
      .set(o.auth)
      .send({
        description: 'Seguro del local',
        category: 'insurance',
        amount: 300,
        dayOfMonth: 1,
        frequency: 'quarterly',
        startDate: start,
        paymentMethod: 'bank_transfer',
      })
      .expect(201);
    expect(tpl.body.frequency).toBe('quarterly');
    // De hace 6 meses a hoy: 3 fechas (hace 6, hace 3 y la de este mes).
    expect(tpl.body.missedDates).toHaveLength(2);
    expect(tpl.body.nextDate).toBe(`${today.slice(0, 7)}-01`);

    const run = await http().post('/expenses/recurring/run').set(o.auth).expect(201);
    expect(run.body.created).toBe(1);
    const generated = await admin.expense.findMany({
      where: { tenantId: o.tenantId, recurringExpenseId: tpl.body.id },
    });
    expect(generated[0]).toMatchObject({
      paymentStatus: 'pending',
      paymentMethod: 'bank_transfer',
    });

    // La plantilla ya no tiene la de este mes pendiente; las anteriores sí se recuperan.
    const list = await http().get('/expenses/recurring').set(o.auth).expect(200);
    const again = (list.body as { id: string; missedDates: string[] }[]).find(
      (r) => r.id === tpl.body.id,
    )!;
    expect(again.missedDates).toHaveLength(0);
    await http()
      .post('/expenses/recurring')
      .set(o.auth)
      .send({
        description: 'Mal',
        amount: 1,
        startDate: today,
        endDate: shift(today, -40),
      })
      .expect(400);

    const fresh = await http()
      .post('/expenses/recurring')
      .set(o.auth)
      .send({
        description: 'Licencia',
        amount: 50,
        dayOfMonth: 1,
        frequency: 'monthly',
        startDate: shiftMonths(today, -2),
      })
      .expect(201);
    expect(fresh.body.missedDates).toHaveLength(2);
    const caught = await http()
      .post(`/expenses/recurring/${fresh.body.id}/catch-up`)
      .set(o.auth)
      .expect(200);
    expect(caught.body.created).toBe(3);
    const second = await http()
      .post(`/expenses/recurring/${fresh.body.id}/catch-up`)
      .set(o.auth)
      .expect(200);
    expect(second.body.created).toBe(0);
  });

  it('cuenta de resultados: reparto, periodo anterior, presupuesto y mes a mes', async () => {
    const o = await owner('exppnl');
    const today = madridToday();
    const a = await createFacilityWithUnits(app, o.accessToken, {
      facilityName: 'Uno',
      unitsCount: 1,
    });
    const b = await createFacilityWithUnits(app, o.accessToken, {
      facilityName: 'Tres',
      unitsCount: 3,
    });
    await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Gestoría', category: 'other', amount: 40, expenseDate: today })
      .expect(201);
    await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Mes pasado', amount: 25, expenseDate: shiftMonths(today, -1) })
      .expect(201);
    await http()
      .put('/expenses/budgets')
      .set(o.auth)
      .send({ budgets: [{ category: 'other', monthlyAmount: 100 }] })
      .expect(200);

    const monthStart = `${today.slice(0, 8)}01`;
    const pnl = await http()
      .get(`/expenses/profit-loss?from=${monthStart}&to=${monthStart}&allocation=units`)
      .set(o.auth)
      .expect(200);
    const rowA = (pnl.body.rows as { facilityId: string; allocatedGeneral: number }[]).find(
      (r) => r.facilityId === a.facilityId,
    );
    const rowB = (pnl.body.rows as { facilityId: string; allocatedGeneral: number }[]).find(
      (r) => r.facilityId === b.facilityId,
    );
    if (today.slice(8) === '01') {
      expect(rowA?.allocatedGeneral).toBe(10);
      expect(rowB?.allocatedGeneral).toBe(30);
    }
    await http()
      .get(`/expenses/profit-loss?from=${monthStart}&to=${today}&allocation=nada`)
      .set(o.auth)
      .expect(400);

    const full = await http()
      .get(`/expenses/profit-loss?from=${monthStart}&to=${today}&allocation=units`)
      .set(o.auth)
      .expect(200);
    const allocated = (full.body.rows as { allocatedGeneral: number }[]).reduce(
      (s, r) => s + r.allocatedGeneral,
      0,
    );
    expect(allocated).toBe(40);
    expect(full.body.totals.expenses).toBe(40);
    const other = (full.body.byCategory as { category: string; budget: number | null }[]).find(
      (c) => c.category === 'other',
    );
    expect(other?.budget).toBeGreaterThan(0);

    const monthly = await http()
      .get(`/expenses/profit-loss/monthly?from=${shiftMonths(today, -1)}&to=${today}`)
      .set(o.auth)
      .expect(200);
    expect(monthly.body.months).toHaveLength(2);
    expect(monthly.body.months[0].expenses).toBe(25);
    expect(monthly.body.months[1].expenses).toBe(40);
  });

  it('cambios en lote, exportación e importación', async () => {
    const o = await owner('explote');
    const today = madridToday();
    const ids: string[] = [];
    for (const d of ['Uno', 'Dos', 'Tres']) {
      const r = await http()
        .post('/expenses')
        .set(o.auth)
        .send({ description: d, amount: 10, expenseDate: today, paymentStatus: 'pending' })
        .expect(201);
      ids.push(r.body.id as string);
    }
    const paid = await http()
      .post('/expenses/bulk')
      .set(o.auth)
      .send({
        action: 'mark_paid',
        ids: ids.slice(0, 2),
        paidAt: today,
        paymentMethod: 'bank_transfer',
      })
      .expect(200);
    expect(paid.body).toEqual({ succeeded: 2, failed: [] });
    const moved = await http()
      .post('/expenses/bulk')
      .set(o.auth)
      .send({ action: 'category', ids, category: 'maintenance' })
      .expect(200);
    expect(moved.body.succeeded).toBe(3);
    await http()
      .post('/expenses/bulk')
      .set(o.auth)
      .send({ action: 'delete', ids: [ids[2]] })
      .expect(200);
    const rows = await http().get('/expenses/export').set(o.auth).expect(200);
    expect(rows.body).toHaveLength(2);
    expect(rows.body.every((e: { category: string }) => e.category === 'maintenance')).toBe(true);

    const csv = [
      'fecha;concepto;base;iva;categoria;proveedor;nif;factura;pagado;forma de pago;vencimiento',
      `${today.split('-').reverse().join('/')};Luz;100,00;21;Suministros;Eléctrica SA;A12345674;E-1;no;Transferencia;${today}`,
      `${today};Agua;;;Suministros;;;;sí;;`,
    ].join('\n');
    const preview = await http()
      .post('/imports/expenses/preview')
      .set(o.auth)
      .send({ csv })
      .expect(201);
    expect(preview.body.summary).toMatchObject({ total: 2, valid: 1, invalid: 1 });
    const commit = await http()
      .post('/imports/expenses/commit')
      .set(o.auth)
      .send({ csv, onDuplicate: 'skip' })
      .expect(201);
    expect(commit.body.summary.created).toBe(1);
    const imported = await admin.expense.findFirstOrThrow({
      where: { tenantId: o.tenantId, description: 'Luz' },
    });
    expect(imported).toMatchObject({
      category: 'utilities',
      paymentStatus: 'pending',
      paymentMethod: 'bank_transfer',
      vendorTaxId: 'A12345674',
      cashMovementId: null,
    });
    const again = await http()
      .post('/imports/expenses/preview')
      .set(o.auth)
      .send({ csv })
      .expect(201);
    expect(again.body.summary.duplicates).toBe(1);
  });
});
