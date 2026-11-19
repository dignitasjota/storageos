import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AnalyticsMonthGenerator } from '../src/modules/reports/generators/analytics-month.generator';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras de Analítica: resumen del mes, deuda por inquilino y local, cartera
 * por debajo del precio, rendimiento por tipo, cuotas que entran y salen,
 * escenarios de la previsión, aplicar varios precios, riesgo con teléfono,
 * tiempos de los contactos y el resumen del mes en PDF.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;

describe('Mejoras de Analítica (e2e)', () => {
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

  async function signed(token: string, unitId: string, price: number, customerId?: string) {
    const customer = customerId ?? (await createCustomer(app, token));
    const c = await http()
      .post('/contracts')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: customer, unitId, startDate: '2025-01-01', priceMonthly: price });
    expect(c.status).toBe(201);
    await http()
      .post(`/contracts/${c.body.id}/sign`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    return { id: c.body.id as string, customerId: customer };
  }

  it('cifras nuevas de un negocio con deuda, cartera por debajo del precio y una baja', async () => {
    const owner = await registerVerifiedUser(app, 'an3figs');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds, facilityId, unitTypeId } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 4, pricePerUnit: 60 },
    );
    await db.unit.updateMany({ where: { id: { in: unitIds } }, data: { widthM: 2, depthM: 2 } });
    // Dos alquilados: uno paga 50 (por debajo de los 60 de hoy) y otro 60.
    const a = await signed(owner.accessToken, unitIds[0]!, 50);
    await signed(owner.accessToken, unitIds[1]!, 60);
    await db.contract.updateMany({
      where: { id: a.id },
      data: { signedAt: new Date('2025-01-01T10:00:00Z') },
    });
    await db.customer.update({ where: { id: a.customerId }, data: { phone: '600 111 222' } });

    // Una factura vencida de A y otra cobrada a los 10 días.
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const seriesId = await ensureDefaultSeries(app, owner.accessToken);
    const today = new Date();
    const issue = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 40 * DAY,
    );
    const base = {
      tenantId: tenant.id,
      seriesId,
      customerId: a.customerId,
      contractId: a.id,
      subtotal: 50,
      taxAmount: 10.5,
      total: 60.5,
    };
    await db.invoice.create({
      data: {
        ...base,
        sequenceNumber: 901,
        invoiceNumber: `AN3-1-${Date.now()}`,
        status: 'overdue',
        issueDate: issue,
        dueDate: new Date(issue.getTime() + 15 * DAY),
      },
    });
    await db.invoice.create({
      data: {
        ...base,
        sequenceNumber: 902,
        invoiceNumber: `AN3-2-${Date.now()}`,
        status: 'paid',
        amountPaid: 60.5,
        issueDate: issue,
        dueDate: new Date(issue.getTime() + 5 * DAY),
        paidAt: new Date(issue.getTime() + 10 * DAY),
      },
    });

    // Un contacto de este mes respondido a las 2 horas.
    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Ana', email: `an3-${Date.now()}@e2e.local`, source: 'web' })
      .expect(201);
    const created = new Date();
    await db.lead.update({
      where: { id: lead.body.id },
      data: {
        createdAt: created,
        contactedAt: new Date(created.getTime() + 2 * 3_600_000),
        status: 'contacted',
      },
    });

    const headline = await http().get('/analytics/headline').set(auth).expect(200);
    expect(headline.body).toMatchObject({ leads: 1, overdue: 60.5 });
    expect(headline.body.occupancy).toBeCloseTo(0.5);

    const arrears = await http().get('/analytics/arrears-breakdown').set(auth).expect(200);
    expect(arrears.body.customerCount).toBe(1);
    expect(arrears.body.byCustomer[0]).toMatchObject({ customerId: a.customerId, amount: 60.5 });
    expect(arrears.body.byCustomer[0].oldestDays).toBeGreaterThanOrEqual(24);
    expect(arrears.body.byFacility[0]).toMatchObject({ facilityId, amount: 60.5 });
    expect(arrears.body).toMatchObject({
      avgDaysToCollect: 10,
      avgDaysLate: 5,
      collectedInvoices: 1,
    });

    const gap = await http().get('/analytics/portfolio-gap').set(auth).expect(200);
    expect(gap.body).toMatchObject({ totalGapMonthly: 10, liveContracts: 2 });
    expect(gap.body.rows).toHaveLength(1);
    expect(gap.body.rows[0]).toMatchObject({
      contractId: a.id,
      paying: 50,
      listPrice: 60,
      gap: 10,
    });

    const economics = await http().get('/analytics/unit-economics').set(auth).expect(200);
    const row = economics.body.rows.find(
      (r: { unitTypeId: string }) => r.unitTypeId === unitTypeId,
    );
    expect(row).toMatchObject({
      units: 4,
      occupied: 2,
      areaM2: 16,
      occupiedAreaM2: 8,
      revenueMonthly: 110,
      revenuePerRentedM2: 13.75,
      avgFee: 55,
      avgListPrice: 60,
    });

    const risk = await http().get('/analytics/churn-risk').set(auth).expect(200);
    const mine = risk.body.items.find((i: { customerId: string }) => i.customerId === a.customerId);
    expect(mine.phone).toBe('600 111 222');
    expect(risk.body.summary.atStakeMonthly).toBeGreaterThanOrEqual(50);

    const funnel = await http().get('/analytics/leads-funnel').set(auth).expect(200);
    expect(funnel.body.timing).toMatchObject({ responded: 1, firstResponseHours: 2 });

    // La baja de un contrato de 60 € este mes.
    const b = await signed(owner.accessToken, unitIds[2]!, 60);
    await db.contract.update({
      where: { id: b.id },
      data: { signedAt: new Date('2025-01-01T10:00:00Z'), status: 'ended', endedAt: new Date() },
    });
    await db.unit.update({ where: { id: unitIds[2]! }, data: { status: 'available' } });
    const churn = await http().get('/analytics/churn-breakdown').set(auth).expect(200);
    const month = churn.body.months[churn.body.months.length - 1];
    expect(month.mrrLost).toBe(60);
    expect(churn.body.ended).toBe(1);
    expect(
      churn.body.tenure.find(
        (t: { bucket: string }) => t.bucket === 'gt24' || t.bucket === '12to24',
      ).ended,
    ).toBe(1);

    const scenarios = await http().get('/analytics/forecast-scenarios').set(auth).expect(200);
    expect(scenarios.body.scenarios.map((s: { key: string }) => s.key)).toEqual([
      'low',
      'expected',
      'high',
    ]);
    expect(scenarios.body.scenarios[1].points).toHaveLength(12);
    expect(
      scenarios.body.segments.find((s: { kind: string }) => s.kind === 'facility'),
    ).toMatchObject({
      id: facilityId,
      capacity: 4,
      occupied: 2,
    });

    // Resumen del mes en PDF: las cifras del mes frente al anterior.
    const ym = today.toISOString().slice(0, 7);
    const result = await app
      .get(AnalyticsMonthGenerator)
      .run({ tenantId: tenant.id, params: { month: ym } });
    const labels = result.rows.map((r) => r.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Facturado (con IVA)',
        'Ocupación al cerrar',
        'Bajas',
        'Contactos recibidos',
      ]),
    );
    const catalog = await http().get('/reports/catalog').set(auth).expect(200);
    expect(catalog.body.map((c: { code: string }) => c.code)).toContain('analytics_month');
  });

  it('aplicar varias sugerencias de precio a la vez', async () => {
    const owner = await registerVerifiedUser(app, 'an3many');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 40,
    });
    const res = await http()
      .post('/analytics/unit-pricing-suggestions/apply-many')
      .set(auth)
      .send({
        items: [
          { unitId: unitIds[0], price: 44 },
          { unitId: unitIds[1], price: 46 },
          { unitId: '00000000-0000-4000-8000-000000000000', price: 50 },
        ],
      })
      .expect(201);
    expect(res.body.applied).toBe(2);
    expect(res.body.failed).toHaveLength(1);
    const units = await db.unit.findMany({ where: { id: { in: unitIds } } });
    expect(units.map((u) => Number(u.basePriceMonthly)).sort()).toEqual([44, 46]);
    await http()
      .post('/analytics/unit-pricing-suggestions/apply-many')
      .set(auth)
      .send({ items: [] })
      .expect(400);
  });
});
