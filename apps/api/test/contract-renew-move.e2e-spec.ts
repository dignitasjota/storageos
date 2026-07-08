import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Renovación de contrato + traslado de trastero (backlog operativo). */
describe('Contrato: renovar + trasladar (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('renueva (extiende endDate) y traslada de trastero (reasigna + estados)', async () => {
    const owner = await registerVerifiedUser(app, 'renewmove');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Contrato firmado (activo) en la unidad 0, con fin a 3 meses.
    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      endDate: '2026-08-01',
      priceMonthly: 60,
      depositAmount: 0,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    // Renovar +12 meses → endDate pasa a 2027-08-01.
    const renewed = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/renew`)
      .set(auth)
      .send({ months: 12 });
    expect(renewed.status).toBe(200);
    expect(renewed.body.endDate).toBe('2027-08-01');

    // Estados de las unidades antes del traslado: 0 ocupada, 1 disponible.
    const u0Before = await adminClient.unit.findUnique({ where: { id: unitIds[0] } });
    expect(u0Before!.status).toBe('occupied');

    // Trasladar a la unidad 1 con nueva cuota 80.
    const moved = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/change-unit`)
      .set(auth)
      .send({ newUnitId: unitIds[1], newPrice: 80 });
    expect(moved.status).toBe(200);
    expect(moved.body.unitId).toBe(unitIds[1]);
    expect(moved.body.priceMonthly).toBe(80);

    // La unidad vieja queda libre, la nueva ocupada.
    const u0 = await adminClient.unit.findUnique({ where: { id: unitIds[0] } });
    const u1 = await adminClient.unit.findUnique({ where: { id: unitIds[1] } });
    expect(u0!.status).toBe('available');
    expect(u1!.status).toBe('occupied');

    // Trasladar a la misma unidad → 400.
    const same = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/change-unit`)
      .set(auth)
      .send({ newUnitId: unitIds[1] });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('same_unit');
  });

  it('traslado con prorate y cuota mayor emite una factura de ajuste', async () => {
    const owner = await registerVerifiedUser(app, 'movepror');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);

    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 60,
      depositAmount: 0,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    // Traslado a un trastero más caro (100) con prorrateo → factura de ajuste.
    const moved = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/change-unit`)
      .set(auth)
      .send({ newUnitId: unitIds[1], newPrice: 100, prorate: true });
    expect(moved.status).toBe(200);

    // Debe existir una factura "Ajuste por cambio de trastero" emitida para el cliente.
    const invoices = await request(app.getHttpServer())
      .get(`/invoices?customerId=${customerId}`)
      .set(auth);
    const adjustment = (
      invoices.body as { status: string; items: { description: string }[] }[]
    ).find((inv) =>
      inv.items.some((it) => it.description.includes('Ajuste por cambio de trastero')),
    );
    expect(adjustment).toBeDefined();
    expect(adjustment!.status).not.toBe('draft'); // emitida
  });

  it('el onboarding refleja los pasos completados', async () => {
    const fresh = await registerVerifiedUser(app, 'onbfresh');
    const freshAuth = { Authorization: `Bearer ${fresh.accessToken}` };

    // Tenant recién registrado: sin local/trastero/inquilino/contrato.
    const before = await request(app.getHttpServer()).get('/dashboard/onboarding').set(freshAuth);
    expect(before.status).toBe(200);
    expect(before.body.completed).toBe(false);
    const facilityStep = (before.body.steps as { key: string; done: boolean }[]).find(
      (s) => s.key === 'facility',
    );
    expect(facilityStep!.done).toBe(false);

    // Tras crear un local, el paso `facility` pasa a done.
    await createFacilityWithUnits(app, fresh.accessToken, { unitsCount: 1 });
    const after = await request(app.getHttpServer()).get('/dashboard/onboarding').set(freshAuth);
    const facilityAfter = (after.body.steps as { key: string; done: boolean }[]).find(
      (s) => s.key === 'facility',
    );
    expect(facilityAfter!.done).toBe(true);
    expect(after.body.progress).toBeGreaterThan(0);
  });
});
