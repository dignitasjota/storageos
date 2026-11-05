import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + offset * DAY),
  );

describe('Mejoras de «Hoy» del panel del tenant (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

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

  async function overdueInvoice(token: string, customerId: string) {
    const id = await createDraftInvoice(app, token, customerId);
    await http()
      .post(`/invoices/${id}/issue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({})
      .expect(200);
    await db.invoice.update({
      where: { id },
      data: { dueDate: new Date(`${isoDay(-4)}T00:00:00.000Z`) },
    });
    return id;
  }

  it('apartar una tarea o una deuda la quita de la lista y de los asuntos', async () => {
    const owner = await registerVerifiedUser(app, 'ttfeat1');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    await overdueInvoice(owner.accessToken, customerId);
    const task = await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Revisar puerta', dueDate: isoDay(0) })
      .expect(201);

    let today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.urgentCount).toBe(2);

    const snooze = await http()
      .post('/dashboard/today/snoozes')
      .set(auth)
      .send({ kind: 'task', refId: task.body.id, days: 3, label: 'Revisar puerta' })
      .expect(201);
    await http()
      .post('/dashboard/today/snoozes')
      .set(auth)
      .send({ kind: 'customer_debt', refId: customerId, days: 7 })
      .expect(201);

    today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.tasksDue.count).toBe(0);
    expect(today.body.urgentCount).toBe(0);
    const extras = await http().get('/dashboard/today/extras').set(auth).expect(200);
    expect(extras.body.debts.count).toBe(0);
    expect(extras.body.snoozed).toHaveLength(2);

    await http().delete(`/dashboard/today/snoozes/${snooze.body.id}`).set(auth).expect(204);
    today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.tasksDue.count).toBe(1);
  });

  it('deuda por inquilino, avisos nuevos y la semana', async () => {
    const owner = await registerVerifiedUser(app, 'ttfeat2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId, unitIds } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 2 },
    );
    const customerId = await createCustomer(app, owner.accessToken);
    await overdueInvoice(owner.accessToken, customerId);
    const second = await overdueInvoice(owner.accessToken, customerId);
    await db.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: second,
        customerId,
        amount: 10,
        currency: 'EUR',
        status: 'failed',
        gateway: 'manual',
        methodType: 'card',
      },
    });
    // Empieza hoy y sigue sin firmar.
    await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], priceMonthly: 40, startDate: isoDay(0) })
      .expect(201);
    await db.waitlistEntry.create({
      data: {
        tenantId: owner.tenantId,
        facilityId,
        unitTypeId,
        contactName: 'Ana en cola',
        contactEmail: 'ana@e2e.local',
      },
    });
    await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Pintar el pasillo', dueDate: isoDay(3) })
      .expect(201);

    const { body } = await http().get('/dashboard/today/extras').set(auth).expect(200);
    expect(body.debts.count).toBe(1);
    expect(body.debts.rows[0].invoiceCount).toBe(2);
    expect(body.paymentProblems.count).toBe(1);
    expect(body.draftsAttention.count).toBe(1);
    expect(body.waitlistMatches.items[0].label).toBe('Ana en cola');
    expect(body.week.map((w: { label: string }) => w.label)).toContain('Pintar el pasillo');
    expect(body.urgentCount).toBe(2);
  });

  it('mañana dice lo que falta y lo hecho hoy suma los cobros', async () => {
    const owner = await registerVerifiedUser(app, 'ttfeat3');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], priceMonthly: 40, startDate: isoDay(1) })
      .expect(201);
    const invoiceId = await overdueInvoice(owner.accessToken, customerId);
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    await http()
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ methodType: 'cash', amount: Number(invoice.total) })
      .expect(200);

    const { body } = await http().get('/dashboard/today/extras').set(auth).expect(200);
    expect(body.tomorrow[0].kind).toBe('in');
    expect(body.tomorrow[0].missing).toContain('Firma');
    expect(body.done.payments[0].label).toBe('Efectivo');
    expect(body.done.collected).toBeCloseTo(Number(invoice.total), 2);
    expect(body.done.cashClosed).toBe(false);
  });

  it('el resumen del día se guarda por persona y el código queda registrado', async () => {
    const owner = await registerVerifiedUser(app, 'ttfeat4');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    const customerId = await createCustomer(app, owner.accessToken);

    const saved = await http()
      .put('/dashboard/me/daily-summary')
      .set(auth)
      .send({ hour: 10, push: true })
      .expect(200);
    expect(saved.body).toEqual({ hour: 10, facilityIds: [], push: true });
    const read = await http().get('/dashboard/me/daily-summary').set(auth).expect(200);
    expect(read.body.hour).toBe(10);
    await http().put('/dashboard/me/daily-summary').set(auth).send({ hour: 2 }).expect(400);

    const pin = await http()
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin', label: 'Mostrador' })
      .expect(201);
    const access = await http()
      .get(`/dashboard/today/desk/customers/${customerId}/access`)
      .set(auth)
      .expect(200);
    expect(access.body.credentials[0].value).toBe(pin.body.revealedSecret);
    const logs = await db.auditLog.count({
      where: { tenantId: owner.tenantId, action: 'access.code_viewed' },
    });
    expect(logs).toBe(1);
  });
});
