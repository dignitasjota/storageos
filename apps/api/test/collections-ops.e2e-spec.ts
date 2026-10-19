import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { invoiceInActivePlan } from '../src/common/payment-plan-guard';
import { PaymentPlansService } from '../src/modules/collections-ops/payment-plans.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Cobros del mes, impagos y planes de pago. */
describe('Cobros del mes, impagos y planes de pago (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('impagos, cobros del mes y plan de pago que pausa y se rompe', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'collops');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const seriesId = await ensureDefaultSeries(app, owner.accessToken);
    const customer = await http()
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Debe',
        lastName: 'Dinero',
        email: 'debe@example.com',
        country: 'ES',
      })
      .expect(201);

    const now = new Date();
    let seq = 7000;
    const invoice = (status: string, total: number, due: Date) =>
      db.invoice.create({
        data: {
          tenantId: owner.tenantId,
          customerId: customer.body.id,
          seriesId,
          invoiceNumber: `T-${seq}`,
          sequenceNumber: seq++,
          status: status as never,
          issueDate: new Date(due.getTime() - 10 * DAY),
          dueDate: due,
          subtotal: total,
          taxAmount: 0,
          total,
          amountPaid: 0,
        },
      });
    const old = await invoice('overdue', 100, new Date(now.getTime() - 40 * DAY));
    const recent = await invoice('overdue', 60, new Date(now.getTime() - 5 * DAY));
    await db.dunningAction.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: old.id,
        actionType: 'late_fee',
        scheduledFor: new Date(now.getTime() + 2 * DAY),
      },
    });

    // Impagos: una fila con las dos facturas, la más antigua manda.
    const arrears = await http().get('/arrears').set(auth).expect(200);
    expect(arrears.body.totalAmount).toBe(160);
    expect(arrears.body.rows).toHaveLength(1);
    expect(arrears.body.rows[0]).toMatchObject({
      customerId: customer.body.id,
      amount: 160,
      invoiceCount: 2,
      chargeable: false,
      plan: null,
      nextStep: { label: 'Recargo por mora' },
    });
    expect(arrears.body.rows[0].days).toBeGreaterThanOrEqual(39);

    // Cobros del mes: lo que vence este mes y lo cobrado.
    const month = iso(now).slice(0, 7);
    await http()
      .post(`/invoices/${recent.id}/mark-paid`)
      .set(auth)
      .send({ amount: 20, methodType: 'cash' })
      .expect(200);
    const res = await http().get(`/collections-month?month=${month}`).set(auth).expect(200);
    expect(res.body.collected.amount).toBe(20);
    expect(res.body.collected.byMethod.cash).toBe(20);
    expect(res.body.weeks.length).toBeGreaterThanOrEqual(4);
    await http().get('/collections-month?month=2026-13').set(auth).expect(400);

    // Plan de pago de lo que queda (100 + 40) en 2 cuotas.
    const firstDue = iso(new Date(now.getTime() - 20 * DAY));
    const plan = await http()
      .post('/payment-plans')
      .set(auth)
      .send({
        customerId: customer.body.id,
        installmentsCount: 2,
        firstDueDate: firstDue,
        frequency: 'monthly',
        graceDays: 7,
      })
      .expect(201);
    expect(plan.body).toMatchObject({ status: 'active', totalAmount: 140, paidSoFar: 0 });
    expect(plan.body.installments.map((i: { amount: number }) => i.amount)).toEqual([70, 70]);
    expect(plan.body.installments[0].status).toBe('late');
    expect(await invoiceInActivePlan(db, old.id)).toBe(true);
    await http()
      .post('/payment-plans')
      .set(auth)
      .send({ customerId: customer.body.id, installmentsCount: 2, firstDueDate: firstDue })
      .expect(409);
    const withPlan = await http().get('/arrears').set(auth).expect(200);
    expect(withPlan.body.rows[0].plan).toMatchObject({ id: plan.body.id, status: 'active' });

    // Pagar la 1ª cuota la pone al día; sin pagarla, el plan se rompe.
    const plans = app.get(PaymentPlansService);
    await http()
      .post(`/invoices/${old.id}/mark-paid`)
      .set(auth)
      .send({ amount: 70, methodType: 'cash' })
      .expect(200);
    expect(await plans.evaluateAll(now)).toMatchObject({ broken: 0 });
    const listed = await http()
      .get(`/payment-plans?customerId=${customer.body.id}`)
      .set(auth)
      .expect(200);
    expect(listed.body[0]).toMatchObject({ status: 'active', paidSoFar: 70 });
    expect(listed.body[0].installments[0].status).toBe('paid');

    await plans.evaluateAll(new Date(now.getTime() + 60 * DAY));
    const broken = await http().get(`/payment-plans?status=broken`).set(auth).expect(200);
    expect(broken.body.map((p: { id: string }) => p.id)).toContain(plan.body.id);
    expect(await invoiceInActivePlan(db, old.id)).toBe(false);

    // Un plan nuevo se puede cancelar.
    const again = await http()
      .post('/payment-plans')
      .set(auth)
      .send({
        customerId: customer.body.id,
        installmentsCount: 3,
        firstDueDate: iso(new Date(now.getTime() + 5 * DAY)),
        notifyCustomer: false,
      })
      .expect(201);
    await http().post(`/payment-plans/${again.body.id}/cancel`).set(auth).expect(200);
    await http().post(`/payment-plans/${again.body.id}/cancel`).set(auth).expect(400);
    await http().get('/arrears').expect(401);
  });
});
