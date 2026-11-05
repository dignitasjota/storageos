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

describe('Revisión del Resumen del panel del tenant (e2e)', () => {
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
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount,
    });
    const overview = async (query = '') => {
      const res = await http().get(`/dashboard/overview${query}`).set(auth).expect(200);
      return res.body as DashboardOverviewDto;
    };
    const signed = async (customerId: string, unitId: string, startDate = isoDay(-40)) => {
      const c = await http()
        .post('/contracts')
        .set(auth)
        .send({ customerId, unitId, priceMonthly: 40, startDate })
        .expect(201);
      await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
      return c.body.id as string;
    };
    const issued = async (customerId: string, dueOffset?: number) => {
      const id = await createDraftInvoice(app, owner.accessToken, customerId);
      await http().post(`/invoices/${id}/issue`).set(auth).send({}).expect(200);
      if (dueOffset !== undefined) {
        await db.invoice.update({
          where: { id },
          data: { dueDate: new Date(`${isoDay(dueOffset)}T00:00:00.000Z`) },
        });
      }
      return id;
    };
    return { owner, auth, facilityId, unitIds, overview, signed, issued };
  }

  /** Lo facturado este mes en la franja y en la última barra de la gráfica. */
  const invoiced = (o: DashboardOverviewDto) => ({
    strip: o.month?.invoicedMonth,
    chart: o.monthlyRevenue?.points.at(-1)?.invoiced,
  });

  it('anular y sustituir una factura cuadra en la franja y en la gráfica', async () => {
    const { auth, owner, overview, issued } = await setup('sumrev1');
    const customerId = await createCustomer(app, owner.accessToken);

    const cancelled = await issued(customerId);
    expect(invoiced(await overview())).toEqual({ strip: 121, chart: 121 });
    await http().post(`/invoices/${cancelled}/cancel`).set(auth).send({ reason: 'x' }).expect(200);
    expect(invoiced(await overview())).toEqual({ strip: 0, chart: 0 });

    const replaced = await issued(customerId);
    const rect = await http()
      .post(`/invoices/${replaced}/rectify`)
      .set(auth)
      .send({
        rectificationType: 'R4',
        reason: 'importe',
        correctionMethod: 'by_substitution',
        items: [{ description: 'Cuota mes', quantity: 1, unitPrice: 80, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${rect.body.id}/issue`).set(auth).send({}).expect(200);
    expect(invoiced(await overview())).toEqual({ strip: 96.8, chart: 96.8 });
  });

  it('el inquilino de prueba no cuenta en ninguna cifra', async () => {
    const { auth, owner, unitIds, overview, signed } = await setup('sumrev2', 2);
    const realCustomer = await createCustomer(app, owner.accessToken);
    await signed(realCustomer, unitIds[0]!);
    const before = await overview();

    const run = await http().post('/dashboard/onboarding/test-run').set(auth).send({}).expect(201);
    await http().post(`/contracts/${run.body.contractId}/sign`).set(auth).send({}).expect(200);
    const after = await overview();

    expect(after.revenue?.mrr).toBe(before.revenue?.mrr);
    expect(after.occupancy?.occupiedUnits).toBe(1);
    expect(after.month?.occupancyPct).toBe(50);
    expect(after.month?.freeUnits).toBe(1);
    expect(after.month?.moveInsMonth).toBe(before.month?.moveInsMonth);
    expect(after.customers).toEqual(before.customers);
    expect(after.churnRisk?.summary.total).toBe(before.churnRisk?.summary.total);
    expect(after.forecast?.current.activeContracts).toBe(1);

    const dash = await http().get('/dashboard/occupancy').set(auth).expect(200);
    expect(dash.body.byStatus.occupied).toBe(1);
  });

  it('la ocupación no cuenta los trasteros de un local borrado', async () => {
    const { auth, owner, unitIds, overview, signed } = await setup('sumrev3', 2);
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    await signed(await createCustomer(app, owner.accessToken), unitIds[0]!);
    await http().delete(`/facilities/${other.facilityId}`).set(auth).expect(204);

    const o = await overview();
    expect(o.occupancy?.totalUnits).toBe(2);
    expect(o.month?.totalUnits).toBe(2);
    expect(o.month?.occupancyPct).toBe(50);
  });

  it('altas y bajas del mes con el criterio de Analítica', async () => {
    const { auth, owner, unitIds, overview, signed } = await setup('sumrev4');
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    const ended = await signed(await createCustomer(app, owner.accessToken), unitIds[0]!);
    const cancelled = await signed(await createCustomer(app, owner.accessToken), unitIds[1]!);
    await db.contract.updateMany({
      where: { tenantId: tenant.id },
      data: {
        signedAt: new Date(Date.now() - 70 * DAY),
        startDate: new Date(Date.now() - 70 * DAY),
      },
    });
    // Entrada este mes de un inquilino que además es nuevo.
    await signed(await createCustomer(app, owner.accessToken), unitIds[2]!, isoDay(0));

    await http().post(`/contracts/${ended}/end`).set(auth).send({}).expect(200);
    await http().post(`/contracts/${cancelled}/cancel`).set(auth).send({}).expect(200);

    const o = await overview();
    expect(o.month?.moveInsMonth).toBe(1);
    expect(o.month?.moveOutsMonth).toBe(2);
    // Solo el de la entrada es nuevo; las fichas sin contrato no cuentan.
    await createCustomer(app, owner.accessToken);
    const after = await overview();
    expect(after.customers?.newThisMonth).toBe(1);
    expect(after.customers?.withActiveContract).toBe(1);
  });

  it('por cobrar separa lo vencido, también lo de hoy sin marcar por la noche', async () => {
    const { auth, owner, overview, issued } = await setup('sumrev5');
    const customerId = await createCustomer(app, owner.accessToken);
    await issued(customerId, 10);
    await issued(customerId, -5);

    const o = await overview();
    expect(o.receivables).toMatchObject({
      total: 242,
      overdue: 121,
      notDue: 121,
      invoices: 2,
      overdueInvoices: 1,
    });
    expect(o.month?.overduePending).toBe(121);

    const suggested = await http().get('/analytics/suggested-actions').set(auth).expect(200);
    const collections = suggested.body.actions.find((a: { id: string }) => a.id === 'collections');
    expect(collections.detail).toContain('121,00');
    expect(collections.href).toBe('/arrears');
  });

  it('la previsión no pasa de los trasteros que hay', async () => {
    const { owner, unitIds, overview, signed } = await setup('sumrev6', 4);
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: owner.slug } });
    for (const unitId of unitIds) {
      await signed(await createCustomer(app, owner.accessToken), unitId);
    }
    await db.contract.updateMany({
      where: { tenantId: tenant.id },
      data: {
        signedAt: new Date(Date.now() - 35 * DAY),
        startDate: new Date(Date.now() - 35 * DAY),
      },
    });

    const { forecast } = await overview();
    expect(forecast?.assumptions.cappedAtCapacity).toBe(true);
    expect(forecast?.points.every((p) => p.projectedActiveContracts <= 4)).toBe(true);
  });

  it('respeta el local elegido y exige el permiso de analítica', async () => {
    const { owner, unitIds, overview, signed } = await setup('sumrev7', 1);
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await signed(await createCustomer(app, owner.accessToken), unitIds[0]!);
    expect((await overview()).revenue?.mrr).toBe(40);
    const scoped = await overview(`?facilityId=${other.facilityId}`);
    expect(scoped.revenue?.mrr).toBe(0);
    expect(scoped.occupancy?.occupiedUnits).toBe(0);
    await http().get('/dashboard/overview').expect(401);
    await http()
      .get('/dashboard/overview?facilityId=nope')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(400);
  });
});
