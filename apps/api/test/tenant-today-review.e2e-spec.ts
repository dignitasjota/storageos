import { PrismaClient } from '@storageos/database';
import { permissionsForRole } from '@storageos/shared';
import request from 'supertest';

import { DailySummaryService } from '../src/modules/dashboard/daily-summary.service';
import { TodaySummaryService } from '../src/modules/dashboard/today-summary.service';
import { TodayService } from '../src/modules/dashboard/today.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
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
const ids = (list: { items: { id: string }[] }) => list.items.map((i) => i.id);

describe('Revisión de «Hoy» del panel del tenant (e2e)', () => {
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

  /** Factura emitida con el vencimiento en `dueOffset` días. */
  async function issuedInvoice(token: string, customerId: string, dueOffset: number) {
    const id = await createDraftInvoice(app, token, customerId);
    await http()
      .post(`/invoices/${id}/issue`)
      .set({ Authorization: `Bearer ${token}` })
      .send({})
      .expect(200);
    await db.invoice.update({
      where: { id },
      data: { dueDate: new Date(`${isoDay(dueOffset)}T00:00:00.000Z`) },
    });
    return id;
  }

  it('salidas atrasadas, sin repetir en «por vencer», y sin tareas borradas', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev1');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = async (unitId: string) => {
      const c = await http()
        .post('/contracts')
        .set(auth)
        .send({
          customerId,
          unitId,
          priceMonthly: 40,
          startDate: isoDay(-100),
          endDate: isoDay(30),
          autoRenew: false,
        })
        .expect(201);
      await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
      return c.body.id as string;
    };
    const late = await contract(unitIds[0]!);
    const leavesToday = await contract(unitIds[1]!);
    await db.contract.update({
      where: { id: late },
      data: { endDate: new Date(`${isoDay(-3)}T00:00:00.000Z`) },
    });
    await db.contract.update({
      where: { id: leavesToday },
      data: { endDate: new Date(`${isoDay(0)}T00:00:00.000Z`) },
    });

    const task = await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Revisar puerta', dueDate: isoDay(0) })
      .expect(201);
    await http().delete(`/tasks/${task.body.id}`).set(auth).expect(204);

    const { body } = await http().get('/dashboard/today').set(auth).expect(200);
    expect(ids(body.moveOutsToday)).toEqual(expect.arrayContaining([late, leavesToday]));
    const lateItem = body.moveOutsToday.items.find((i: { id: string }) => i.id === late);
    expect(lateItem.overdue).toBe(true);
    expect(ids(body.contractsEndingSoon)).not.toContain(leavesToday);
    expect(body.tasksDue.count).toBe(0);
  });

  it('una fianza que no se cobró no se liquida', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);
    const make = async (unitId: string) => {
      const c = await http()
        .post('/contracts')
        .set(auth)
        .send({ customerId, unitId, priceMonthly: 40, depositAmount: 60, startDate: isoDay(-40) })
        .expect(201);
      await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
      return c.body.id as string;
    };
    const unpaid = await make(unitIds[0]!);
    const collected = await make(unitIds[1]!);
    await http()
      .post(`/contracts/${collected}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    await db.contract.updateMany({
      where: { id: { in: [unpaid, collected] } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const { body } = await http().get('/dashboard/today').set(auth).expect(200);
    expect(ids(body.depositsToSettle)).toEqual([collected]);
  });

  it('la deuda cuenta una vez por inquilino, igual en la bandeja y en las cifras', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev3');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    await issuedInvoice(owner.accessToken, customerId, -4);
    await issuedInvoice(owner.accessToken, customerId, -2);

    const { body } = await http().get('/dashboard/today').set(auth).expect(200);
    expect(body.invoicesOverdue.count).toBe(2);
    expect(body.urgentCount).toBe(1);

    const summary = await http().get('/dashboard/today/summary').set(auth).expect(200);
    expect(summary.body.kpis.overduePending).toBe(body.invoicesOverdue.totalPending);
  });

  it('lo que ya se está cobrando no se reclama ni cuenta', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev4');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await issuedInvoice(owner.accessToken, customerId, -4);
    await db.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId,
        customerId,
        amount: 10,
        currency: 'EUR',
        status: 'processing',
        gateway: 'manual',
        methodType: 'sepa_debit',
      },
    });

    const { body } = await http().get('/dashboard/today').set(auth).expect(200);
    const item = body.invoicesOverdue.items[0];
    expect(item.note).toBe('Cobro en curso');
    expect(item.chargeable).toBe(false);
    expect(body.urgentCount).toBe(0);

    const remind = await http()
      .post('/invoices/bulk/remind')
      .set(auth)
      .send({ ids: [invoiceId] })
      .expect(200);
    expect(remind.body.succeeded).toEqual([]);
    expect(remind.body.failed[0].error).toBe('payment_in_progress');
  });

  it('lo cobrado no lleva fianzas y resta lo devuelto', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev5');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        priceMonthly: 40,
        depositAmount: 60,
        startDate: isoDay(-5),
      })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    await http()
      .post(`/contracts/${c.body.id}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);

    const invoiceId = await issuedInvoice(owner.accessToken, customerId, 5);
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    await http()
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ methodType: 'cash', amount: Number(invoice.total) })
      .expect(200);
    await db.payment.updateMany({
      where: { invoiceId },
      data: { refundedAmount: 10, status: 'partially_refunded' },
    });

    const { body } = await http().get('/dashboard/today/summary').set(auth).expect(200);
    expect(body.kpis.collectedMonth).toBeCloseTo(Number(invoice.total) - 10, 2);
  });

  it('cada apartado sale solo con su permiso, también en las cifras', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev6');
    const customerId = await createCustomer(app, owner.accessToken);
    await issuedInvoice(owner.accessToken, customerId, -4);
    await db.dataSubjectRequest.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        email: 'privado@e2e.local',
        requestType: 'access',
        status: 'open',
        dueAt: new Date(Date.now() - DAY),
      },
    });

    const all = permissionsForRole('owner');
    const limited = permissionsForRole('readonly').filter((p) => p !== 'invoices:read');
    const today = app.get(TodayService);
    const full = await today.getToday(owner.tenantId, { permissions: all });
    expect(full.invoicesOverdue.count).toBe(1);
    expect(full.rgpdRequestsDue.count).toBe(1);

    const hidden = await today.getToday(owner.tenantId, { permissions: limited });
    expect(hidden.invoicesOverdue).toEqual({ count: 0, totalPending: 0, items: [] });
    expect(hidden.rgpdRequestsDue).toEqual({ count: 0, items: [] });
    expect(hidden.urgentCount).toBe(0);

    const summary = await app
      .get(TodaySummaryService)
      .summary(owner.tenantId, undefined, null, limited);
    expect(summary.kpis.moneyVisible).toBe(false);
    expect(summary.kpis.overduePending).toBe(0);
  });

  it('«Lo mío» solo cuenta lo asignado', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev7');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    await issuedInvoice(owner.accessToken, customerId, -4);

    const team = await http().get('/dashboard/today').set(auth).expect(200);
    expect(team.body.urgentCount).toBe(1);
    const mine = await http().get('/dashboard/today?mine=1').set(auth).expect(200);
    expect(mine.body.urgentCount).toBe(0);
  });

  it('el resumen del día sale aunque el API estuviera parado a las 8', async () => {
    const owner = await registerVerifiedUser(app, 'ttrev8');
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { timezone: 'Europe/Madrid' },
    });
    await db.user.updateMany({
      where: { tenantId: owner.tenantId },
      data: { emailNoticePrefs: { daily_summary: true } },
    });
    const customerId = await createCustomer(app, owner.accessToken);
    await issuedInvoice(owner.accessToken, customerId, -4);
    const base = new Date();
    base.setUTCMinutes(5, 0, 0);
    const at = (hour: number) => {
      for (let h = 0; h < 24; h += 1) {
        const d = new Date(base);
        d.setUTCHours(h);
        const local = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Madrid',
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(d);
        if (Number(local) === hour) return d;
      }
      throw new Error('hora no encontrada');
    };
    const service = app.get(DailySummaryService);

    await service.sendDue(at(14));
    let u = await db.user.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    expect(u.dailySummaryLastDate).toBeNull();

    await service.sendDue(at(10));
    u = await db.user.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    expect(u.dailySummaryLastDate).not.toBeNull();
  });
});
