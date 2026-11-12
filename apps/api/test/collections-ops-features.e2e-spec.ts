import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { ArrearsDto, DebtorPaymentResultDto, MonthCollectionsDto } from '@storageos/shared';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** El mes en curso y el anterior, en la hora de España (`AAAA-MM`). */
function months(): { month: string; prev: string } {
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' })
    .format(new Date())
    .slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { month, prev: new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7) };
}

/**
 * Mejoras de Cobros del mes y Deudores: comparación con el mes anterior, tasa
 * de cobro y lo que falta por vía; facturas de cada deudor, apartarlo unos
 * días y el enlace del área de clientes; y el pago recibido de un deudor,
 * repartido de la factura más antigua a la más nueva.
 */
describe('Cobros del mes y Deudores: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  async function issued(customerId: string, unitPrice: number): Promise<string> {
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  /** Factura emitida con vencimiento en `due` (vencida si es anterior a hoy). */
  async function dueOn(customerId: string, unitPrice: number, due: string): Promise<string> {
    const id = await issued(customerId, unitPrice);
    await admin.invoice.update({
      where: { id },
      data: {
        dueDate: new Date(`${due}T00:00:00Z`),
        ...(due < iso(new Date()) ? { status: 'overdue' } : {}),
      },
    });
    return id;
  }

  const ago = (days: number) => iso(new Date(Date.now() - days * DAY));

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    owner = await registerVerifiedUser(app, 'opsfeat');
    await ensureDefaultSeries(app, owner.accessToken);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('cobros del mes: mes anterior, tasa de cobro y lo que falta por cobrar por vía', async () => {
    const { month, prev } = months();
    const customerId = await createCustomer(app, owner.accessToken);

    // Mes anterior: una cobrada en ese mes y otra sin cobrar.
    const paid = await dueOn(customerId, 100, `${prev}-05`);
    await http()
      .post(`/invoices/${paid}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'bank_transfer', paidAt: `${prev}-10T12:00:00.000Z` })
      .expect(200);
    await dueOn(customerId, 100, `${prev}-12`);
    // Este mes: una sin cobrar y sin forma de pago (se reclama a mano).
    await dueOn(customerId, 50, `${month}-01`);

    const res = (await http().get(`/collections-month?month=${month}`).set(auth()).expect(200))
      .body as MonthCollectionsDto;
    expect(res.previous.month).toBe(prev);
    expect(res.previous.expected).toEqual({ count: 2, amount: 242 });
    expect(res.previous.outstanding).toEqual({ count: 1, amount: 121 });
    expect(res.previous.collected).toEqual({ count: 1, amount: 121 });
    expect(res.previous.collectionRate).toBe(0.5);
    expect(res.outstandingByVia.manual).toEqual({ count: 1, amount: 60.5 });
    expect(res.outstandingByVia.auto).toEqual({ count: 0, amount: 0 });
    expect(res.outstandingByVia.remittance).toEqual({ count: 0, amount: 0 });
    // Vencida el día 1: si hoy no es el 1, ya cuenta y no se ha cobrado nada.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
      new Date(),
    );
    expect(res.collectionRate).toBe(today > `${month}-01` ? 0 : null);

    await http().get('/collections-month?month=2026-13').set(auth()).expect(400);
  });

  it('deudores: facturas de cada uno, apartar unos días y enlace del área de clientes', async () => {
    const customerId = await createCustomer(app, owner.accessToken);
    const old = await dueOn(customerId, 50, ago(40));
    const recent = await dueOn(customerId, 100, ago(10));

    const find = async () => {
      const body = (await http().get('/arrears').set(auth()).expect(200)).body as ArrearsDto;
      return { body, row: body.rows.find((r) => r.customerId === customerId)! };
    };
    const first = await find();
    expect(first.body.portalUrl).toContain('/portal/login');
    expect(first.row.invoices.map((i) => [i.id, i.pending])).toEqual([
      [old, 60.5],
      [recent, 121],
    ]);
    expect(first.row.snoozed).toBeNull();

    const snooze = await http()
      .post('/dashboard/today/snoozes')
      .set(auth())
      .send({ kind: 'customer_debt', refId: customerId, days: 3, label: 'Deudor' })
      .expect(201);
    const second = await find();
    expect(second.row.snoozed?.id).toBe(snooze.body.id);
    expect(second.body.actionable).toBe(first.body.actionable - 1);

    await http().delete(`/dashboard/today/snoozes/${snooze.body.id}`).set(auth()).expect(204);
    const third = await find();
    expect(third.row.snoozed).toBeNull();
    expect(third.body.actionable).toBe(first.body.actionable);
  });

  it('pago recibido de un deudor: de la más antigua a la más nueva, parcial solo en efectivo', async () => {
    const customerId = await createCustomer(app, owner.accessToken);
    const old = await dueOn(customerId, 50, ago(40)); // 60,50
    const recent = await dueOn(customerId, 100, ago(10)); // 121
    const pay = (body: object, id = customerId) =>
      http().post(`/arrears/${id}/payment`).set(auth()).send(body);

    const tooMuch = await pay({ amount: 500, methodType: 'cash' }).expect(400);
    expect(tooMuch.body.code).toBe('amount_exceeds_debt');
    const partial = await pay({ amount: 100, methodType: 'bank_transfer' }).expect(400);
    expect(partial.body.code).toBe('partial_only_cash');

    // Una transferencia que cubre justo la más antigua.
    const whole = (await pay({ amount: 60.5, methodType: 'bank_transfer' }).expect(200))
      .body as DebtorPaymentResultDto;
    expect(whole.applied).toEqual([
      expect.objectContaining({ invoiceId: old, amount: 60.5, status: 'paid' }),
    ]);
    expect(whole.failed).toBeNull();
    expect(whole.remaining).toBe(121);

    // En efectivo se admite pagar una parte de la siguiente.
    const cash = (await pay({ amount: 50, methodType: 'cash' }).expect(200))
      .body as DebtorPaymentResultDto;
    expect(cash.applied).toEqual([expect.objectContaining({ invoiceId: recent, amount: 50 })]);
    expect(cash.remaining).toBe(71);
    const inv = await admin.invoice.findUniqueOrThrow({ where: { id: recent } });
    expect(Number(inv.amountPaid)).toBe(50);

    // Con un cobro con tarjeta en curso no se registra otro.
    const other = await createCustomer(app, owner.accessToken);
    const charging = await dueOn(other, 100, ago(5));
    await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: charging,
        customerId: other,
        amount: 121,
        status: 'processing',
        methodType: 'card',
        gateway: 'stripe',
      },
    });
    const inFlight = await pay({ amount: 121, methodType: 'bank_transfer' }, other).expect(409);
    expect(inFlight.body.code).toBe('payment_in_progress');

    // Inquilino que no existe (o de otra empresa) y uno sin nada vencido.
    const ghost = await pay(
      { amount: 10, methodType: 'cash' },
      '00000000-0000-4000-8000-000000000000',
    ).expect(404);
    expect(ghost.body.code).toBe('customer_not_found');
    const clean = await createCustomer(app, owner.accessToken);
    const none = await pay({ amount: 10, methodType: 'cash' }, clean).expect(400);
    expect(none.body.code).toBe('no_overdue_debt');
  });
});
