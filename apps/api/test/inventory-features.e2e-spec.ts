import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { FacilityDocumentsExpiryCron } from '../src/modules/inventory/facility-documents-expiry.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Funcionalidades de Inventario: stock con movimientos y mínimo, ficha del
 * trastero, acciones en lote, alta masiva, quién ocupa cada trastero del plano,
 * documentos del local, mantenimiento con fecha y tarea, propietarios y
 * resumen de locales, y lo que sale en «Hoy».
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;

describe('Funcionalidades de Inventario (e2e)', () => {
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

  it('stock con movimientos y aviso de mínimo en «Hoy»', async () => {
    const owner = await registerVerifiedUser(app, 'invstock');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await ensureDefaultSeries(app, owner.accessToken);
    const p = await http()
      .post('/products')
      .set(auth)
      .send({ sku: 'CAJA-M', name: 'Caja M', price: 5, minStock: 3 })
      .expect(201);
    await http()
      .put(`/products/${p.body.id}/stock`)
      .set(auth)
      .send({ facilityId, quantity: 4, notes: 'Entrada del proveedor' })
      .expect(200);
    await http()
      .post('/product-sales')
      .set(auth)
      .send({ facilityId, items: [{ productId: p.body.id, quantity: 2 }] })
      .expect(201);
    const moves = await http().get(`/products/${p.body.id}/stock/movements`).set(auth).expect(200);
    expect(moves.body.map((m: { kind: string; delta: number }) => [m.kind, m.delta])).toEqual([
      ['sale', -2],
      ['set', 4],
    ]);
    const list = await http().get('/products').set(auth).expect(200);
    expect(list.body[0]).toMatchObject({ minStock: 3, lowStock: true, totalStock: 2 });
    const today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.lowStock.count).toBe(1);
  });

  it('ficha del trastero, lote, alta masiva, plano y mantenimiento', async () => {
    const owner = await registerVerifiedUser(app, 'invunits2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId, unitIds, floorId } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 2 },
    );

    // Alta masiva: A-01…A-05 (A-03 ya existe y se salta).
    await http()
      .post('/units')
      .set(auth)
      .send({ facilityId, unitTypeId, code: 'A-03', widthM: 1, depthM: 1, heightM: 2 })
      .expect(201);
    const bulkCreate = await http()
      .post('/units/bulk-create')
      .set(auth)
      .send({
        facilityId,
        unitTypeId,
        prefix: 'A-',
        start: 1,
        count: 5,
        padding: 2,
        widthM: 2,
        depthM: 3,
        heightM: 2.5,
        basePriceMonthly: 60,
      })
      .expect(201);
    expect(bulkCreate.body).toEqual({ created: 4, skipped: ['A-03'] });

    // En lote: subir un 10 % el precio de los dos primeros.
    const bulk = await http()
      .post('/units/bulk')
      .set(auth)
      .send({ action: 'price', unitIds, mode: 'percent', value: 10 })
      .expect(200);
    expect(bulk.body).toMatchObject({ updated: 2, failed: [] });
    // Una transición imposible se informa por trastero.
    const badStatus = await http()
      .post('/units/bulk')
      .set(auth)
      .send({ action: 'status', unitIds: [unitIds[0]], status: 'occupied' })
      .expect(200);
    expect(badStatus.body.failed[0].code).toBe('occupied_via_contract_only');

    // Contrato + ficha: historial de precios e inquilinos.
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2025-01-01',
        priceMonthly: 55,
        depositAmount: 0,
      })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    const insights = await http().get(`/units/${unitIds[0]}/insights`).set(auth).expect(200);
    expect(insights.body.priceHistory).toHaveLength(1);
    expect(insights.body.tenancies[0]).toMatchObject({ contractId: c.body.id, priceMonthly: 55 });
    expect(insights.body.daysVacant).toBeNull();

    // Quién ocupa cada trastero de la planta.
    const occupants = await http().get(`/floors/${floorId}/occupants`).set(auth).expect(200);
    expect(occupants.body).toEqual([
      expect.objectContaining({ unitId: unitIds[0], customerId, overdue: 0 }),
    ]);

    // Mantenimiento con fecha prevista y tarea; pasada la fecha sale en «Hoy».
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const maint = await http()
      .post(`/units/${unitIds[1]}/change-status`)
      .set(auth)
      .send({ status: 'maintenance', reason: 'Puerta rota', until: yesterday, createTask: true })
      .expect(200);
    expect(maint.body.maintenanceUntil).toBe(yesterday);
    const task = await db.task.findFirst({ where: { unitId: unitIds[1] } });
    expect(task).toMatchObject({ type: 'maintenance', description: 'Puerta rota' });
    const today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.unitsOutOfService.items[0]).toMatchObject({ id: unitIds[1], overdue: true });
    // Al volver al servicio se borra la fecha.
    const back = await http()
      .post(`/units/${unitIds[1]}/change-status`)
      .set(auth)
      .send({ status: 'available' })
      .expect(200);
    expect(back.body.maintenanceUntil).toBeNull();

    // Resumen de los locales.
    const summary = await http().get('/facilities/summary').set(auth).expect(200);
    expect(summary.body[0]).toMatchObject({ facilityId, mrr: 55, avgPrice: 55, outOfService: 0 });
  });

  it('documentos del local con caducidad y aviso', async () => {
    const owner = await registerVerifiedUser(app, 'invdocs');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const up = await http()
      .post(`/facilities/${facilityId}/documents/upload-url`)
      .set(auth)
      .send({ mimeType: 'application/pdf', sizeBytes: 20 })
      .expect(200);
    const put = await fetch(up.body.uploadUrl, {
      method: 'PUT',
      headers: up.body.requiredHeaders,
      body: Buffer.from('%PDF-1.4\n%%EOF\n'),
    });
    expect(put.ok).toBe(true);
    const inTen = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const doc = await http()
      .post(`/facilities/${facilityId}/documents`)
      .set(auth)
      .send({
        key: up.body.key,
        kind: 'insurance',
        name: 'Póliza del local',
        mimeType: 'application/pdf',
        sizeBytes: 15,
        expiresOn: inTen,
      })
      .expect(201);
    expect(doc.body.daysToExpiry).toBe(10);
    // Una clave de otro sitio no se acepta.
    await http()
      .post(`/facilities/${facilityId}/documents`)
      .set(auth)
      .send({
        key: 'otro/fichero.pdf',
        kind: 'other',
        name: 'X',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      })
      .expect(400);
    const dl = await http()
      .get(`/facilities/${facilityId}/documents/${doc.body.id}/download`)
      .set(auth)
      .expect(200);
    expect(dl.body.url).toContain('http');
    const today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.facilityDocumentsExpiring.items[0]).toMatchObject({ id: doc.body.id });

    const cron = app.get(FacilityDocumentsExpiryCron);
    await cron.run();
    const notif = await db.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'facility.document_expiring' },
    });
    expect(notif?.title).toContain('Póliza del local');
    // Una sola vez.
    expect((await cron.run()).notified).toBe(0);

    await http().delete(`/facilities/${facilityId}/documents/${doc.body.id}`).set(auth).expect(204);
    const after = await http().get(`/facilities/${facilityId}/documents`).set(auth).expect(200);
    expect(after.body).toHaveLength(0);
  });

  it('resumen de propietarios y locales sin propietario', async () => {
    const owner = await registerVerifiedUser(app, 'invowners');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'multi_owner', true);
    const a = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Norte',
      typeName: 'Norte',
      unitsCount: 2,
    });
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Sur',
      typeName: 'Sur',
      unitsCount: 1,
    });
    const o = await http()
      .post('/owners')
      .set(auth)
      .send({
        legalName: 'Inversiones Norte SL',
        taxId: 'B12345674',
        feeType: 'percentage',
        feeValue: 10,
      })
      .expect(201);
    await http()
      .patch(`/facilities/${a.facilityId}`)
      .set(auth)
      .send({ ownerId: o.body.id })
      .expect(200);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId: await createCustomer(app, owner.accessToken),
        unitId: a.unitIds[0],
        startDate: '2025-01-01',
        priceMonthly: 70,
        depositAmount: 0,
      })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);

    const res = await http().get('/owners/overview').set(auth).expect(200);
    expect(res.body.owners[0]).toMatchObject({
      ownerId: o.body.id,
      units: 2,
      occupied: 1,
      mrr: 70,
    });
    expect(res.body.facilitiesWithoutOwner.map((f: { name: string }) => f.name)).toEqual([
      'Local Sur',
    ]);
  });
});
