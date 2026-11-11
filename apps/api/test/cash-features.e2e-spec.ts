import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { CashClosureDto, CashDaySummaryDto, TodayExtrasDto } from '@storageos/shared';

const DAY = 86_400_000;
/** El día de hoy (o el de hace `n` días) en la hora de España. */
const madridDay = (n = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() - n * DAY),
  );

/**
 * Mejoras de la caja: fondo, cambio y retiradas cuentan en el esperado; el día
 * cerrado no admite movimientos; el arqueo guarda el recuento por billetes y
 * monedas y de dónde salía el esperado; el historial se filtra por mes y caja;
 * y «Hoy» avisa de las cajas de días anteriores sin cerrar.
 */
describe('Caja: mejoras (e2e)', () => {
  let app: INestApplication;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });
  const summary = async (date: string) =>
    (await http().get(`/cash/summary?date=${date}`).set(auth()).expect(200))
      .body as CashDaySummaryDto;

  async function paidInCash(paidAt: string): Promise<string> {
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash', paidAt })
      .expect(200);
    return id;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    owner = await registerVerifiedUser(app, 'cashfeat');
    await ensureDefaultSeries(app, owner.accessToken);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('fondo, cambio y retiradas en el esperado; recuento por billetes; día cerrado sin movimientos', async () => {
    const today = madridDay();
    const invoiceId = await paidInCash(new Date().toISOString());
    const float = await http()
      .post('/cash/movements')
      .set(auth())
      .send({ date: today, kind: 'opening_float', amount: 100 })
      .expect(201);
    await http()
      .post('/cash/movements')
      .set(auth())
      .send({ date: today, kind: 'bank_withdrawal', amount: 30, notes: 'Ingreso en el banco' })
      .expect(201);
    await http()
      .post('/cash/movements')
      .set(auth())
      .send({ date: madridDay(-2), kind: 'change_in', amount: 10 })
      .expect(400);

    const s = await summary(today);
    expect(s.movementsIn).toBe(100);
    expect(s.movementsOut).toBe(30);
    expect(s.lastOpeningFloat).toBe(100);
    expect(s.expectedCash).toBe(191); // 121 + 100 − 30
    expect(s.cashLines).toEqual([
      expect.objectContaining({ kind: 'payment', amount: 121, invoiceId }),
    ]);
    expect(s.cashLines[0]!.invoiceNumber).toBeTruthy();
    expect(s.cashLines[0]!.customerName).toBeTruthy();

    // El recuento tiene que sumar lo contado: 3 × 50 + 2 × 20 + 1 × 1 = 191.
    const wrong = await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: today, countedCash: 191, denominations: { '5000': 3 } })
      .expect(400);
    expect(wrong.body.code).toBe('denominations_mismatch');
    const closed = (
      await http()
        .post('/cash/close')
        .set(auth())
        .send({
          date: today,
          countedCash: 191,
          denominations: { '5000': 3, '2000': 2, '100': 1, '50': 0 },
        })
        .expect(201)
    ).body as CashClosureDto;
    expect(closed.difference).toBe(0);
    expect(closed.denominations).toEqual({ '5000': 3, '2000': 2, '100': 1 });
    expect(closed.breakdown).toEqual(
      expect.objectContaining({ cashIn: 121, movementsIn: 100, movementsOut: 30 }),
    );

    // Con la caja cerrada no entra ni sale ningún movimiento de ese día.
    const blocked = await http()
      .post('/cash/movements')
      .set(auth())
      .send({ date: today, kind: 'change_in', amount: 20 })
      .expect(409);
    expect(blocked.body.code).toBe('cash_day_closed');
    await http().delete(`/cash/movements/${float.body.id}`).set(auth()).expect(409);

    // Reabierta, se puede quitar el fondo.
    await http()
      .post(`/cash/closures/${closed.id}/reopen`)
      .set(auth())
      .send({ reason: 'Fondo mal apuntado' })
      .expect(200);
    await http().delete(`/cash/movements/${float.body.id}`).set(auth()).expect(204);
    expect((await summary(today)).expectedCash).toBe(91);

    // Historial por mes y por caja; el PDF de un cierre que no existe da 404.
    const month = today.slice(0, 7);
    const ofMonth = (await http().get(`/cash/closures?month=${month}`).set(auth()).expect(200))
      .body as CashClosureDto[];
    expect(ofMonth.map((c) => c.id)).toContain(closed.id);
    const global = (
      await http().get(`/cash/closures?month=${month}&facilityId=global`).set(auth()).expect(200)
    ).body as CashClosureDto[];
    expect(global.map((c) => c.id)).toContain(closed.id);
    await http().get('/cash/closures?month=2026-13').set(auth()).expect(400);
    await http().get('/cash/closures?facilityId=nope').set(auth()).expect(400);
    await http()
      .get('/cash/closures/00000000-0000-4000-8000-000000000000/pdf')
      .set(auth())
      .expect(404);
  });

  it('«Hoy» avisa de las cajas de días anteriores con efectivo y sin cerrar', async () => {
    // El negocio cierra la caja (tiene un cierre reciente)...
    await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: madridDay(5), countedCash: 0 })
      .expect(201);
    // ...y anteayer y ayer movió efectivo sin cerrar.
    await http()
      .post('/cash/movements')
      .set(auth())
      .send({ date: madridDay(2), kind: 'change_in', amount: 20 })
      .expect(201);
    await paidInCash(`${madridDay(1)}T10:00:00.000Z`);

    const extras = (await http().get('/dashboard/today/extras').set(auth()).expect(200))
      .body as TodayExtrasDto;
    const item = extras.cashUnclosed.items.find((i) => i.refId === owner.tenantId);
    expect(item).toBeDefined();
    expect(item!.label).toBe('Caja de toda la empresa');
    expect(item!.date).toBe(madridDay(2));
    expect(item!.href).toBe(`/cash?date=${madridDay(2)}`);

    // Cerrado el día de anteayer, el aviso pasa a ayer.
    await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: madridDay(2), countedCash: 20 })
      .expect(201);
    const after = (await http().get('/dashboard/today/extras').set(auth()).expect(200))
      .body as TodayExtrasDto;
    expect(after.cashUnclosed.items.find((i) => i.refId === owner.tenantId)?.date).toBe(
      madridDay(1),
    );
  });
});
