import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** DNI con su letra de control. */
function dni(seed: number): string {
  const n = 20_000_000 + seed;
  return `${n}${'TRWAGMYFPDXBNJZSQVHLCKE'[n % 23]}`;
}

const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

/**
 * Revisión de Gastos y Fiscalidad: la cuenta de resultados cuadra con el
 * Resumen, el alcance por local se respeta en todo, los recurrentes no se
 * duplican, la exportación para la asesoría deja las anuladas a 0 y no repite
 * devoluciones, el 347 suma por NIF y los libros guardan los datos del cliente
 * de cuando se emitió.
 */
describe('Revisión de Gastos y Fiscalidad (e2e)', () => {
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
    return res.body as { id: string; invoiceNumber: string };
  }

  it('la cuenta de resultados va sin IVA, cuadra con el Resumen y pone cada factura en su local', async () => {
    const o = await owner('pnlrev');
    const a = await createFacilityWithUnits(app, o.accessToken, { facilityName: 'Local A' });
    const b = await createFacilityWithUnits(app, o.accessToken, { facilityName: 'Local B' });
    const customerId = await createCustomer(app, o.accessToken, { documentNumber: dni(1) });

    // 100 + IVA, sustituida por otra de 150 + IVA (cuenta la diferencia).
    const first = await createDraftInvoice(app, o.accessToken, customerId, { unitPrice: 100 });
    await http().post(`/invoices/${first}/issue`).set(o.auth).send({}).expect(200);
    const sub = await http()
      .post(`/invoices/${first}/rectify`)
      .set(o.auth)
      .send({
        rectificationType: 'R1',
        reason: 'Importe corregido',
        correctionMethod: 'by_substitution',
        items: [{ description: 'Cuota corregida', quantity: 1, unitPrice: 150, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${sub.body.id}/issue`).set(o.auth).send({}).expect(200);
    // Una venta suelta con su propio local (B).
    await issue(o.auth, {
      customerId,
      facilityId: b.facilityId,
      items: [{ description: 'Candado', quantity: 1, unitPrice: 50, taxRate: 21 }],
    });
    await http()
      .post('/expenses')
      .set(o.auth)
      .send({
        description: 'Luz',
        amount: 30,
        expenseDate: madridToday(),
        facilityId: a.facilityId,
      })
      .expect(201);

    const today = madridToday();
    const monthStart = `${today.slice(0, 8)}01`;
    const last = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0));
    const monthEnd = last.toISOString().slice(0, 10);
    const pnl = await http()
      .get(`/expenses/profit-loss?from=${monthStart}&to=${monthEnd}`)
      .set(o.auth)
      .expect(200);
    expect(pnl.body.totals.invoiced).toBe(200); // 150 + 50, sin IVA
    expect(pnl.body.totals.expenses).toBe(30);
    expect(pnl.body.totals.net).toBe(170);
    expect(pnl.body.invoicesVisible).toBe(true);
    const rowB = (pnl.body.rows as { facilityId: string | null; invoiced: number }[]).find(
      (r) => r.facilityId === b.facilityId,
    );
    expect(rowB?.invoiced).toBe(50);

    const overview = await http().get('/dashboard/overview?period=month').set(o.auth).expect(200);
    expect(overview.body.result.income).toBe(pnl.body.totals.invoiced);
    expect(overview.body.result.net).toBe(pnl.body.totals.net);
  });

  it('respeta el alcance por local, el local de otra empresa y valida lo que llega', async () => {
    const o = await owner('scoperev');
    const other = await owner('scopeother');
    const a = await createFacilityWithUnits(app, o.accessToken, { facilityName: 'Local A' });
    const b = await createFacilityWithUnits(app, o.accessToken, { facilityName: 'Local B' });
    const foreign = await createFacilityWithUnits(app, other.accessToken, {
      facilityName: 'Ajeno',
    });
    const today = madridToday();

    // El local de otra empresa no vale (antes se guardaba).
    const cross = await http()
      .post('/expenses')
      .set(o.auth)
      .send({
        description: 'Cruce',
        amount: 10,
        expenseDate: today,
        facilityId: foreign.facilityId,
      })
      .expect(400);
    expect(cross.body.code).toBe('facility_not_found');

    const inB = await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Gasto B', amount: 20, expenseDate: today, facilityId: b.facilityId })
      .expect(201);

    const mgr = await scopedUser(app, o, { role: 'manager', facilityIds: [a.facilityId] });
    const forbidden = await http()
      .post('/expenses')
      .set(mgr)
      .send({ description: 'En B', amount: 5, expenseDate: today, facilityId: b.facilityId })
      .expect(403);
    expect(forbidden.body.code).toBe('facility_not_in_scope');
    const general = await http()
      .post('/expenses')
      .set(mgr)
      .send({ description: 'General', amount: 5, expenseDate: today })
      .expect(403);
    expect(general.body.code).toBe('facility_required');
    await http()
      .post('/expenses')
      .set(mgr)
      .send({ description: 'En A', amount: 7, expenseDate: today, facilityId: a.facilityId })
      .expect(201);
    await http().patch(`/expenses/${inB.body.id}`).set(mgr).send({ amount: 1 }).expect(404);
    await http().delete(`/expenses/${inB.body.id}`).set(mgr).expect(404);

    const pnl = await http()
      .get(`/expenses/profit-loss?from=${today}&to=${today}`)
      .set(mgr)
      .expect(200);
    const ids = (pnl.body.rows as { facilityId: string | null }[]).map((r) => r.facilityId);
    expect(ids).toContain(a.facilityId);
    expect(ids).not.toContain(b.facilityId);

    // Fiscalidad: de toda la empresa.
    const year = today.slice(0, 4);
    const fiscal = await http()
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(mgr)
      .expect(403);
    expect(fiscal.body.code).toBe('fiscal_requires_all_facilities');

    // Lo que antes daba error 500.
    await http().get('/expenses/page?from=nofecha').set(o.auth).expect(400);
    await http().get('/expenses/page?facilityId=abc').set(o.auth).expect(400);
    await http().get('/expenses/profit-loss').set(o.auth).expect(400);
    await http()
      .post('/expenses')
      .set(o.auth)
      .send({ description: 'Enorme', amount: 1e13, expenseDate: today })
      .expect(400);
    await http().get(`/fiscal/model-303?year=${year}&quarter=abc`).set(o.auth).expect(400);
    await http().get(`/fiscal/model-303?year=${year}&quarter=1.5`).set(o.auth).expect(400);

    // Total de lo filtrado.
    const total = await http()
      .get(`/expenses/total?from=${today}&to=${today}`)
      .set(o.auth)
      .expect(200);
    expect(total.body).toEqual({ count: 2, amount: 27 });
  });

  it('los recurrentes no se duplican, el canal se quita fuera de Marketing y lo sincronizado no se toca', async () => {
    const o = await owner('recrev');
    for (const description of ['Alquiler', 'Luz', 'Internet']) {
      await http()
        .post('/expenses/recurring')
        .set(o.auth)
        .send({ description, amount: 100, dayOfMonth: 1, category: 'rent' })
        .expect(201);
    }
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => http().post('/expenses/recurring/run').set(o.auth)),
    );
    const created = runs.reduce((sum, r) => sum + (r.body.created as number), 0);
    expect(created).toBe(3);
    const generated = await admin.expense.findMany({
      where: { tenantId: o.tenantId, recurringExpenseId: { not: null } },
    });
    expect(generated).toHaveLength(3);

    // Canal de marketing: al pasar a otra categoría deja de contar en el canal.
    const channel = await http()
      .post('/marketing/channels')
      .set(o.auth)
      .send({ type: 'real_estate_portal', name: 'Portal', monthlyCost: 50 })
      .expect(201);
    const today = madridToday();
    const exp = await http()
      .post('/expenses')
      .set(o.auth)
      .send({
        description: 'Anuncio',
        amount: 50,
        expenseDate: today,
        category: 'marketing',
        marketingChannelId: channel.body.id,
      })
      .expect(201);
    expect(exp.body.marketingChannelId).toBe(channel.body.id);
    const moved = await http()
      .patch(`/expenses/${exp.body.id}`)
      .set(o.auth)
      .send({ category: 'other' })
      .expect(200);
    expect(moved.body.marketingChannelId).toBeNull();

    // Sincronizado de Google Ads: se ve el origen y no se edita ni se borra.
    const synced = await admin.expense.create({
      data: {
        tenantId: o.tenantId,
        category: 'marketing',
        description: 'Google Ads — Campaña',
        amount: 12,
        expenseDate: new Date(`${today}T00:00:00Z`),
        externalRef: `google_ads:123:${today}`,
      },
    });
    const list = await http().get(`/expenses?from=${today}&to=${today}`).set(o.auth).expect(200);
    expect(
      (list.body as { id: string; source: string }[]).find((e) => e.id === synced.id)?.source,
    ).toBe('google_ads');
    const blocked = await http()
      .patch(`/expenses/${synced.id}`)
      .set(o.auth)
      .send({ amount: 1 })
      .expect(409);
    expect(blocked.body.code).toBe('expense_synced');
    await http().delete(`/expenses/${synced.id}`).set(o.auth).expect(409);

    // La misma referencia en otra empresa ya no choca.
    const other = await owner('recother');
    await admin.expense.create({
      data: {
        tenantId: other.tenantId,
        category: 'marketing',
        description: 'Google Ads — Campaña',
        amount: 9,
        expenseDate: new Date(`${today}T00:00:00Z`),
        externalRef: `google_ads:123:${today}`,
      },
    });
  });

  it('exportación: anulada a 0, cobro devuelto en negativo y la fianza devuelta una sola vez', async () => {
    const o = await owner('exprev');
    const { unitIds } = await createFacilityWithUnits(app, o.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, o.accessToken, { documentNumber: dni(7) });
    const today = madridToday();

    // Anulada por error: sale con importe 0.
    const voided = await issue(o.auth, {
      customerId,
      items: [{ description: 'Error', quantity: 1, unitPrice: 400, taxRate: 21 }],
    });
    await http()
      .post(`/invoices/${voided.id}/void`)
      .set(o.auth)
      .send({ reason: 'Emitida por error a otro cliente' })
      .expect(200);

    // Cobrada y después devuelta por el banco.
    const paid = await issue(o.auth, {
      customerId,
      items: [{ description: 'Cuota', quantity: 1, unitPrice: 100, taxRate: 21 }],
    });
    await http()
      .post(`/invoices/${paid.id}/mark-paid`)
      .set(o.auth)
      .send({ amount: 121, methodType: 'bank_transfer' })
      .expect(200);
    await admin.payment.updateMany({
      where: { invoiceId: paid.id },
      data: { status: 'failed', returnedAt: new Date() },
    });

    // Fianza cobrada, devuelta por el cobro y luego liquidada como devuelta.
    const contract = await http()
      .post('/contracts')
      .set(o.auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: today,
        priceMonthly: 50,
        depositAmount: 60,
      })
      .expect(201);
    const contractId = contract.body.id as string;
    await http().post(`/contracts/${contractId}/sign`).set(o.auth).expect(200);
    await http()
      .post(`/contracts/${contractId}/deposit/collect`)
      .set(o.auth)
      .send({ methodType: 'card' })
      .expect(200);
    await admin.payment.updateMany({
      where: { invoice: { contractId, kind: 'deposit_receipt' } },
      data: { refundedAmount: 60, refundedAt: new Date(), status: 'refunded' },
    });
    await http()
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(o.auth)
      .send({ returnedAmount: 60, returnMethod: 'card' })
      .expect(200);

    const exp = await http()
      .get(`/fiscal/accountant-export?from=${today}&to=${today}&format=json`)
      .set(o.auth)
      .expect(200);
    const voidRow = (
      exp.body.invoices as { invoiceNumber: string; base: number; vat: number; status: string }[]
    ).find((r) => r.invoiceNumber === voided.invoiceNumber);
    expect(voidRow).toMatchObject({ base: 0, vat: 0, status: 'Anulada por error' });

    const payRows = (
      exp.body.payments as { invoiceNumber: string | null; amount: number }[]
    ).filter((r) => r.invoiceNumber === paid.invoiceNumber);
    expect(payRows.map((r) => r.amount).sort((x, y) => x - y)).toEqual([-121, 121]);

    const depositRows = (
      exp.body.deposits as { contractNumber: string | null; movement: string; amount: number }[]
    ).filter((r) => r.contractNumber === contract.body.contractNumber);
    expect(depositRows.filter((r) => r.movement === 'returned')).toHaveLength(1);
    expect(depositRows.reduce((sum, r) => sum + r.amount, 0)).toBe(0);
  });

  it('el 347 suma por NIF y los libros guardan el cliente de cuando se emitió', async () => {
    const o = await owner('m347rev');
    const nif = dni(347);
    const c1 = await createCustomer(app, o.accessToken, { documentNumber: nif });
    const c2 = await http()
      .post('/customers')
      .set(o.auth)
      .send({
        customerType: 'individual',
        firstName: 'Otra',
        lastName: 'Ficha',
        email: `m347-${Date.now()}@e2e.local`,
        documentNumber: nif,
        country: 'ES',
      });
    expect([200, 201]).toContain(c2.status);
    for (const customerId of [c1, c2.body.id as string]) {
      const id = await createDraftInvoice(app, o.accessToken, customerId, { unitPrice: 2000 });
      await http().post(`/invoices/${id}/issue`).set(o.auth).send({}).expect(200);
    }
    const year = madridToday().slice(0, 4);
    const m347 = await http().get(`/fiscal/model-347?year=${year}`).set(o.auth).expect(200);
    expect(m347.body.rows).toHaveLength(1);
    expect(m347.body.rows[0]).toMatchObject({ nif, total: 4840 });

    // Se edita la ficha después: el libro de IVA sigue con el nombre de entonces.
    const before = await http()
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(o.auth)
      .expect(200);
    const nameThen = (before.body.rows as { customerName: string }[])[0]!.customerName;
    await http()
      .patch(`/customers/${c1}`)
      .set(o.auth)
      .send({ firstName: 'Cambiado', lastName: 'Después' })
      .expect(200);
    const after = await http()
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(o.auth)
      .expect(200);
    const names = (after.body.rows as { customerName: string }[]).map((r) => r.customerName);
    expect(names).toContain(nameThen);
    expect(names).not.toContain('Cambiado Después');
  });
});
