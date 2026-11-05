import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { DashboardOverviewDto } from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + offset * DAY),
  );

describe('Mejoras del Resumen del panel del tenant (e2e)', () => {
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

  async function setup(prefix: string, unitsCount = 3) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount,
      pricePerUnit: 50,
    });
    const overview = async (query = '') => {
      const res = await http().get(`/dashboard/overview${query}`).set(auth).expect(200);
      return res.body as DashboardOverviewDto;
    };
    const contract = async (unitId: string, body: Record<string, unknown> = {}) => {
      const customerId = await createCustomer(app, owner.accessToken);
      const c = await http()
        .post('/contracts')
        .set(auth)
        .send({ customerId, unitId, priceMonthly: 40, startDate: isoDay(-40), ...body })
        .expect(201);
      return { id: c.body.id as string, customerId };
    };
    const sign = (id: string) =>
      http().post(`/contracts/${id}/sign`).set(auth).send({}).expect(200);
    return { owner, auth, facility, overview, contract, sign };
  }

  it('el periodo cambia las cifras y compara con el anterior', async () => {
    const { owner, auth, overview } = await setup('sumfeat1', 1);
    const customerId = await createCustomer(app, owner.accessToken);
    const issue = async (date: string) => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId);
      await http().post(`/invoices/${id}/issue`).set(auth).send({}).expect(200);
      await db.invoice.update({
        where: { id },
        data: { issueDate: new Date(`${date}T00:00:00.000Z`) },
      });
    };
    await issue(isoDay(0));
    const lastMonth = new Date(`${isoDay(0).slice(0, 7)}-15T00:00:00.000Z`);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await issue(lastMonth.toISOString().slice(0, 10));

    const year = (await overview('?period=12m')).period;
    expect(year).toMatchObject({ period: '12m', invoiced: 242 });

    const last = (await overview('?period=last_month')).period;
    expect(last).toMatchObject({ invoiced: 121 });
    expect(last?.previous.invoiced).toBe(0);

    await http().get('/dashboard/overview?period=siempre').set(auth).expect(400);
  });

  it('caja del mes, trasteros libres y movimiento', async () => {
    const { owner, auth, facility, overview, contract, sign } = await setup('sumfeat2');
    const customerId = await createCustomer(app, owner.accessToken);
    const issued = async (dueOffset: number) => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId);
      await http().post(`/invoices/${id}/issue`).set(auth).send({}).expect(200);
      await db.invoice.update({
        where: { id },
        data: { dueDate: new Date(`${isoDay(dueOffset)}T00:00:00.000Z`) },
      });
      return id;
    };
    await issued(-5);
    await issued(70);
    const paid = await issued(-1);
    await http()
      .post(`/invoices/${paid}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    const leaving = await contract(facility.unitIds[0]!, {
      endDate: isoDay(10),
      autoRenew: false,
    });
    await sign(leaving.id);
    const entering = await contract(facility.unitIds[1]!, { startDate: isoDay(5) });
    await sign(entering.id);

    const o = await overview();
    // Vencido: los 121 € más la primera factura del contrato firmado con fecha pasada.
    expect(o.cash).toMatchObject({ collected: 121, dueLater: 121 });
    expect(o.cash?.overdue).toBe(o.receivables?.overdue);
    expect(o.vacancy).toMatchObject({ freeUnits: 1, monthlyValue: 50 });
    expect(o.vacancy?.byType[0]).toMatchObject({ free: 1, monthlyValue: 50 });
    expect(o.moves?.expiring.map((m) => m.contractId)).toEqual([leaving.id]);
    expect(o.moves?.upcomingMoveIns.map((m) => m.contractId)).toEqual([entering.id]);
    expect(o.moves?.moveIns.map((m) => m.contractId)).toContain(leaving.id);
  });

  it('tabla por local, resultado y pendiente de cerrar', async () => {
    const { owner, auth, facility, overview, contract, sign } = await setup('sumfeat3', 2);
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const live = await contract(facility.unitIds[0]!);
    await sign(live.id);
    const draft = await contract(facility.unitIds[1]!);
    await http().post(`/contracts/${draft.id}/request-signature`).set(auth).send({}).expect(201);

    const invoice = await createDraftInvoice(app, owner.accessToken, live.customerId);
    await http().post(`/invoices/${invoice}/issue`).set(auth).send({}).expect(200);
    await http()
      .post('/expenses')
      .set(auth)
      .send({ category: 'rent', description: 'Alquiler', amount: 30, expenseDate: isoDay(0) })
      .expect(201);
    await http()
      .post('/leads')
      .set(auth)
      .send({ source: 'web', firstName: 'Ana', email: 'ana-sumfeat3@e2e.local' })
      .expect(201);

    const o = await overview();
    const row = o.byFacility?.find((f) => f.facilityId === facility.facilityId);
    expect(row).toMatchObject({ occupiedUnits: 1, totalUnits: 2, mrr: 40, occupancyPct: 50 });
    expect(o.byFacility?.find((f) => f.facilityId === other.facilityId)?.mrr).toBe(0);
    expect(o.result?.expenses).toBe(30);
    expect(o.result?.net).toBe(Number(((o.result?.income ?? 0) - 30).toFixed(2)));
    expect(o.commercial).toMatchObject({ openLeads: 1, pendingSignature: 1 });
  });

  it('cada usuario guarda sus tarjetas y su orden', async () => {
    const { auth } = await setup('sumfeat4', 0);
    const initial = await http().get('/dashboard/me/layout').set(auth).expect(200);
    expect(initial.body.order[0]).toBe('suggestions');
    expect(initial.body.hidden).toEqual([]);

    const saved = await http()
      .put('/dashboard/me/layout')
      .set(auth)
      .send({ order: ['kpis', 'suggestions'], hidden: ['forecast'] })
      .expect(200);
    expect(saved.body.order.indexOf('kpis')).toBeLessThan(saved.body.order.indexOf('suggestions'));

    const again = await http().get('/dashboard/me/layout').set(auth).expect(200);
    expect(again.body.hidden).toEqual(['forecast']);

    await http()
      .put('/dashboard/me/layout')
      .set(auth)
      .send({ order: ['otra'], hidden: [] })
      .expect(400);
  });
});
