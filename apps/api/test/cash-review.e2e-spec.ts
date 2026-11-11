import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { PaymentsService } from '../src/modules/payments/payments.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Hoy en hora de Madrid (la zona de los tenants de prueba). */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

/**
 * Revisión de la caja: con el día cerrado no entran ni salen movimientos en
 * efectivo (se reabre con motivo); cada devolución cuenta por cómo salió el
 * dinero; la fianza devuelta en efectivo sale del cajón y la aplicada no es un
 * cobro; Bizum tiene su línea; un cobro devuelto cuenta el día cobrado y resta
 * el día devuelto, y vuelve a contar si se gana la disputa.
 */
describe('Cierre de caja: revisión (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  async function issued(customerId: string, unitPrice = 100): Promise<string> {
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  const summary = async () =>
    (await http().get('/cash/summary').set(auth()).expect(200)).body as {
      date: string;
      cash: number;
      card: number;
      bizum: number;
      bankTransfer: number;
      other: number;
      refunds: Record<string, number>;
      returned: number;
      cashRefunds: number;
      depositReturnsCash: number;
      expectedCash: number;
      closure: { id: string } | null;
    };

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    owner = await registerVerifiedUser(app, 'cashrev');
    await ensureDefaultSeries(app, owner.accessToken);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('con la caja cerrada no entra ni sale efectivo; reabrir con motivo lo permite', async () => {
    const customerId = await createCustomer(app, owner.accessToken);
    const paid = await issued(customerId);
    const other = await issued(customerId);
    await http()
      .post(`/invoices/${paid}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    const closed = await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: today(), countedCash: 121 })
      .expect(201);
    expect(closed.body.difference).toBe(0);

    const blocked = await http()
      .post(`/invoices/${other}/mark-paid`)
      .set(auth())
      .send({ amount: 50, methodType: 'cash' })
      .expect(409);
    expect(blocked.body.code).toBe('cash_day_closed');
    // Lo que no es efectivo no toca el cajón.
    await http()
      .post(`/invoices/${other}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'bank_transfer' })
      .expect(200);
    const refundBlocked = await http()
      .post(`/invoices/${paid}/refund`)
      .set(auth())
      .send({ amount: 21, reason: 'Ajuste', refundMethod: 'cash' })
      .expect(409);
    expect(refundBlocked.body.code).toBe('cash_day_closed');

    const reopened = await http()
      .post(`/cash/closures/${closed.body.id as string}/reopen`)
      .set(auth())
      .send({ reason: 'Falta una devolución' })
      .expect(200);
    expect(reopened.body.reopenedAt).toBeTruthy();
    expect(reopened.body.reopenReason).toBe('Falta una devolución');
    const twice = await http()
      .post(`/cash/closures/${closed.body.id as string}/reopen`)
      .set(auth())
      .send({ reason: 'Otra vez' })
      .expect(409);
    expect(twice.body.code).toBe('closure_already_reopened');

    await http()
      .post(`/invoices/${paid}/refund`)
      .set(auth())
      .send({ amount: 21, reason: 'Ajuste', refundMethod: 'cash' })
      .expect(200);
    const s = await summary();
    expect(s.closure).toBeNull();
    expect(s.cash).toBe(121);
    expect(s.bankTransfer).toBe(121);
    expect(s.refunds.cash).toBe(21);
    expect(s.cashRefunds).toBe(21);
    expect(s.expectedCash).toBe(100);
    const again = await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: today(), countedCash: 100 })
      .expect(201);
    expect(again.body.expectedCash).toBe(100);
    const list = (await http().get('/cash/closures').set(auth()).expect(200)).body as {
      id: string;
      reopenedAt: string | null;
    }[];
    expect(list.find((c) => c.id === closed.body.id)?.reopenedAt).toBeTruthy();
    expect(list.find((c) => c.id === again.body.id)?.reopenedAt).toBeNull();
    // Se deja abierta para las pruebas siguientes.
    await http()
      .post(`/cash/closures/${again.body.id as string}/reopen`)
      .set(auth())
      .send({ reason: 'Siguen las pruebas' })
      .expect(200);
  });

  it('fianza: la devuelta en efectivo sale del cajón y la aplicada no es un cobro; Bizum aparte', async () => {
    const before = await summary();
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http()
      .post('/contracts')
      .set(auth())
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-05-01',
        priceMonthly: 60,
        depositAmount: 100,
      })
      .expect(201);
    const contractId = contract.body.id as string;
    await http().post(`/contracts/${contractId}/sign`).set(auth()).expect(200);
    await http()
      .post(`/contracts/${contractId}/deposit/collect`)
      .set(auth())
      .send({ methodType: 'cash' })
      .expect(200);
    // Una factura pendiente del contrato que salda lo retenido.
    const owedRes = await http()
      .post('/invoices')
      .set(auth())
      .send({
        customerId,
        contractId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    const owed = owedRes.body.id as string;
    await http().post(`/invoices/${owed}/issue`).set(auth()).expect(200);
    await http()
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth())
      .send({
        returnedAmount: 60,
        retentionReason: 'Deuda pendiente',
        applyToInvoices: true,
        returnMethod: 'cash',
      })
      .expect(200);
    const applied = await admin.payment.findFirstOrThrow({ where: { invoiceId: owed } });
    expect(applied.methodType).toBe('deposit');

    const bizumInvoice = await issued(customerId, 10);
    await http()
      .post(`/invoices/${bizumInvoice}/mark-paid`)
      .set(auth())
      .send({ amount: 12.1, methodType: 'bizum' })
      .expect(200);

    const s = await summary();
    expect(s.cash).toBe(before.cash + 100);
    expect(s.depositReturnsCash).toBe(before.depositReturnsCash + 60);
    expect(s.expectedCash).toBe(before.expectedCash + 40);
    // La fianza aplicada (12,10 €) no aparece como «otros».
    expect(s.other).toBe(before.other);
    expect(s.bizum).toBe(before.bizum + 12.1);
  });

  it('un cobro devuelto cuenta el día cobrado, resta el día devuelto y vuelve si se gana la disputa', async () => {
    const before = await summary();
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await issued(customerId);
    const intent = `pi_cashrev_${Date.now()}`;
    await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId,
        customerId,
        amount: 121,
        status: 'succeeded',
        methodType: 'card',
        gateway: 'stripe',
        gatewayPaymentId: intent,
        paidAt: new Date(),
      },
    });
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { amountPaid: 121, status: 'paid', paidAt: new Date() },
    });
    const payments = app.get(PaymentsService);
    await payments.syncDisputeFromWebhook({
      tenantId: owner.tenantId,
      gatewayPaymentId: intent,
      reason: 'fraudulent',
    });
    const s = await summary();
    expect(s.card).toBe(before.card + 121);
    expect(s.returned).toBe(before.returned + 121);

    await payments.syncDisputeClosedFromWebhook({
      tenantId: owner.tenantId,
      gatewayPaymentId: intent,
      status: 'won',
    });
    let invoice = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    for (let i = 0; i < 40 && invoice.status !== 'paid'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      invoice = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    }
    expect(invoice.status).toBe('paid');
    expect(Number(invoice.amountPaid)).toBe(121);
    const restored = await admin.payment.findFirstOrThrow({ where: { gatewayPaymentId: intent } });
    expect(restored.status).toBe('succeeded');
    expect(restored.returnedAt).toBeNull();
    expect((await summary()).returned).toBe(before.returned);
  });

  it('fechas y locales comprobados; quien ve unos locales no ve la caja de toda la empresa', async () => {
    await http().get('/cash/summary?date=2026-02-31').set(auth()).expect(400);
    const future = await http().get('/cash/summary?date=2099-01-01').set(auth()).expect(400);
    expect(future.body.code).toBe('date_in_future');
    await http()
      .get('/cash/summary?facilityId=00000000-0000-4000-8000-000000000000')
      .set(auth())
      .expect(404);
    await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: '2026-02-31', countedCash: 0 })
      .expect(400);

    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const global = await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: '2026-01-05', countedCash: 0 })
      .expect(201);
    const local = await http()
      .post('/cash/close')
      .set(auth())
      .send({ date: '2026-01-05', countedCash: 0, facilityId })
      .expect(201);
    const scoped = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [facilityId],
      tag: 'cashscope',
    });
    const seen = (await http().get('/cash/closures').set(scoped).expect(200)).body as {
      id: string;
    }[];
    expect(seen.map((c) => c.id)).toEqual([local.body.id]);
    await http()
      .post(`/cash/closures/${global.body.id as string}/reopen`)
      .set(scoped)
      .send({ reason: 'No debería poder' })
      .expect(404);
    const required = await http().get('/cash/summary').set(scoped).expect(400);
    expect(required.body.code).toBe('facility_required');
    await http().get(`/cash/summary?facilityId=${facilityId}`).set(scoped).expect(200);
  });
});
