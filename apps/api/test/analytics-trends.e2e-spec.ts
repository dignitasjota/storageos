import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { CollectionsMonthGenerator } from '../src/modules/reports/generators/collections-month.generator';
import { MoveOutsPeriodGenerator } from '../src/modules/reports/generators/move-outs-period.generator';
import { OccupancySnapshotGenerator } from '../src/modules/reports/generators/occupancy-snapshot.generator';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Funcionalidades de Analítica: ocupación mes a mes, de dónde sale lo
 * facturado, cohortes de altas, avisos de competencia, riesgo de baja con los
 * accesos y los informes nuevos.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;

function ymOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('Tendencias de Analítica (e2e)', () => {
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

  async function signed(token: string, customerId: string, unitId: string, price = 50) {
    const c = await http()
      .post('/contracts')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, unitId, startDate: '2025-01-01', priceMonthly: price, depositAmount: 0 });
    expect(c.status).toBe(201);
    await http()
      .post(`/contracts/${c.body.id}/sign`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    return c.body.id as string;
  }

  it('ocupación mes a mes, cohortes e informes de ocupación y bajas', async () => {
    const owner = await registerVerifiedUser(app, 'antrend');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 4 });
    const fourMonthsAgo = new Date(Date.now() - 120 * DAY);
    await db.unit.updateMany({
      where: { id: { in: unitIds } },
      data: { createdAt: fourMonthsAgo },
    });

    // Dos contratos desde hace 4 meses; uno se dio de baja hace un mes.
    const a = await signed(
      owner.accessToken,
      await createCustomer(app, owner.accessToken),
      unitIds[0]!,
      60,
    );
    const b = await signed(
      owner.accessToken,
      await createCustomer(app, owner.accessToken),
      unitIds[1]!,
      40,
    );
    await db.contract.updateMany({
      where: { id: { in: [a, b] } },
      data: { signedAt: fourMonthsAgo },
    });
    const monthAgo = new Date(Date.now() - 30 * DAY);
    await db.contract.update({ where: { id: b }, data: { status: 'ended', endedAt: monthAgo } });
    await db.unit.update({ where: { id: unitIds[1]! }, data: { status: 'available' } });

    const hist = await http().get('/analytics/occupancy-history?months=6').set(auth).expect(200);
    expect(hist.body.points).toHaveLength(6);
    const last = hist.body.points[5];
    expect(last).toMatchObject({ totalUnits: 4, occupiedUnits: 1, mrr: 60 });
    const threeAgo = hist.body.points[2];
    expect(threeAgo).toMatchObject({ totalUnits: 4, occupiedUnits: 2 });
    expect(hist.body.byFacility).toHaveLength(1);
    expect(hist.body.byUnitType[0].occupancy).toHaveLength(6);

    const cohorts = await http().get('/analytics/cohorts?months=12').set(auth).expect(200);
    const row = cohorts.body.cohorts.find(
      (c: { yearMonth: string }) => c.yearMonth === ymOf(fourMonthsAgo),
    );
    expect(row).toMatchObject({ contracts: 2, retained3: 0.5, retained12: null });

    const occ = await app
      .get(OccupancySnapshotGenerator)
      .run({ tenantId: owner.tenantId, params: {} });
    expect(occ.rows[0]).toMatchObject({ total: 4, occupied: 1, available: 3, mrr: 60 });

    const from = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const outs = await app
      .get(MoveOutsPeriodGenerator)
      .run({ tenantId: owner.tenantId, params: { from, to } });
    expect(outs.rows).toHaveLength(1);
    expect(outs.rows[0]).toMatchObject({ type: 'Finalizado', price: 40 });

    // Catálogo: los informes nuevos; el de propietarios solo con propietarios.
    const catalog = await http().get('/reports/catalog').set(auth).expect(200);
    const codes = (catalog.body as { code: string }[]).map((c) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining(['occupancy_snapshot', 'collections_month', 'move_outs_period']),
    );
    expect(codes).not.toContain('owner_statement');
    await db.owner.create({
      data: { tenantId: owner.tenantId, legalName: 'Inversiones Norte SL', taxId: 'B12345674' },
    });
    const withOwner = await http().get('/reports/catalog').set(auth).expect(200);
    const ownerReport = (
      withOwner.body as { code: string; paramsSchema: Record<string, { options?: unknown[] }> }[]
    ).find((c) => c.code === 'owner_statement');
    expect(ownerReport?.paramsSchema.ownerId?.options).toHaveLength(1);
  });

  it('de dónde sale lo facturado y cobros del mes', async () => {
    const owner = await registerVerifiedUser(app, 'anbreak');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await signed(owner.accessToken, customerId, unitIds[0]!);
    const seriesId = await ensureDefaultSeries(app, owner.accessToken);
    const today = new Date();
    const invoice = await db.invoice.create({
      data: {
        tenantId: owner.tenantId,
        seriesId,
        sequenceNumber: 0,
        customerId,
        contractId,
        invoiceNumber: `BRK-${Date.now()}`,
        status: 'paid',
        issueDate: today,
        subtotal: 60,
        taxAmount: 12.6,
        total: 72.6,
        amountPaid: 72.6,
        items: {
          create: [
            {
              tenantId: owner.tenantId,
              description: 'Alquiler trastero',
              quantity: 1,
              unitPrice: 50,
              taxRate: 21,
              taxAmount: 10.5,
              total: 60.5,
            },
            {
              tenantId: owner.tenantId,
              description: 'Protección de contenido — Básico',
              quantity: 1,
              unitPrice: 10,
              taxRate: 21,
              taxAmount: 2.1,
              total: 12.1,
            },
          ],
        },
      },
    });
    await db.payment.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        invoiceId: invoice.id,
        amount: 72.6,
        currency: 'EUR',
        status: 'succeeded',
        methodType: 'bank_transfer',
        gateway: 'manual',
        paidAt: today,
      },
    });

    const res = await http().get('/analytics/revenue-breakdown').set(auth).expect(200);
    expect(res.body.total).toBe(60);
    expect(res.body.byConcept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'rent', amount: 50 }),
        expect.objectContaining({ key: 'insurance', amount: 10 }),
      ]),
    );
    expect(res.body.byUnitType[0].amount).toBe(50);
    await http().get('/analytics/revenue-breakdown?from=hoy').set(auth).expect(400);

    const report = await app
      .get(CollectionsMonthGenerator)
      .run({ tenantId: owner.tenantId, params: { month: ymOf(today) } });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ method: 'Transferencia', amount: 72.6 });
  });

  it('riesgo de baja avisa de quien no entra y la competencia que baja precios', async () => {
    const owner = await registerVerifiedUser(app, 'anaccess');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds, facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 80,
    });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await signed(owner.accessToken, customerId, unitIds[0]!);
    await db.contract.update({
      where: { id: contractId },
      data: { signedAt: new Date(Date.now() - 200 * DAY) },
    });
    await db.accessCredential.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        method: 'pin',
        status: 'active',
        secretHash: 'x',
        secretPreview: '1234',
      },
    });
    const risk = await http().get('/analytics/churn-risk').set(auth).expect(200);
    const item = risk.body.items.find((i: { contractId: string }) => i.contractId === contractId);
    // Sin método de pago (15) + nunca ha entrado (10) = 25: aún bajo, no sale en el detalle.
    expect(item).toBeUndefined();
    expect(risk.body.summary.low).toBe(1);

    // Competencia: un trastero parecido baja de 90 a 60 € (tú, 80 €).
    const comp = await db.competitorFacility.create({
      data: { tenantId: owner.tenantId, name: 'TrasterPlus', facilityId },
    });
    const unit = await db.competitorUnit.create({
      data: {
        tenantId: owner.tenantId,
        competitorFacilityId: comp.id,
        areaM2: 6,
        priceMonthly: 60,
        status: 'available',
      },
    });
    await db.competitorUnitObservation.createMany({
      data: [
        {
          tenantId: owner.tenantId,
          competitorUnitId: unit.id,
          priceMonthly: 90,
          status: 'available',
          observedAt: new Date(Date.now() - 10 * DAY),
        },
        {
          tenantId: owner.tenantId,
          competitorUnitId: unit.id,
          priceMonthly: 60,
          status: 'available',
          observedAt: new Date(Date.now() - 2 * DAY),
        },
      ],
    });
    const alerts = await http().get('/analytics/competition-alerts').set(auth).expect(200);
    expect(alerts.body.stale).toHaveLength(1);
    expect(alerts.body.priceDrops[0]).toMatchObject({
      competitorName: 'TrasterPlus',
      previousPrice: 90,
      newPrice: 60,
      myPrice: 80,
    });
    const actions = await http().get('/analytics/suggested-actions').set(auth).expect(200);
    const cats = (actions.body.actions as { category: string }[]).map((a) => a.category);
    expect(cats).toContain('competition');
  });
});
