import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Extra «Viviendas»: tipos de unidad vivienda con el alquiler exento de IVA. */
describe('Viviendas (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('sin el extra no se marca una vivienda; con él, el alquiler sale exento', async () => {
    const owner = await registerVerifiedUser(app, 'housing');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 700,
    });

    const denied = await request(app.getHttpServer())
      .patch(`/unit-types/${unitTypeId}`)
      .set(auth)
      .send({ propertyKind: 'housing' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('feature_not_in_plan');
    const deniedCreate = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Piso', defaultPriceMonthly: 700, propertyKind: 'housing' });
    expect(deniedCreate.status).toBe(403);

    await setTenantFeatureOverride(owner.slug, 'housing', true);
    const ok = await request(app.getHttpServer())
      .patch(`/unit-types/${unitTypeId}`)
      .set(auth)
      .send({ propertyKind: 'housing' });
    expect(ok.status).toBe(200);
    expect(ok.body.propertyKind).toBe('housing');

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Piso', country: 'ES' });
    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId: customer.body.id,
      unitId: unitIds[0],
      startDate: '2026-03-01',
      priceMonthly: 700,
      depositAmount: 0,
    });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({})
      .expect(200);

    await app.get(BillingJobsService).processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    });
    const invoice = await admin.invoice.findFirst({
      where: { contractId: contract.body.id, kind: 'invoice' },
      include: { items: true },
    });
    expect(invoice).not.toBeNull();
    expect(Number(invoice!.taxAmount)).toBe(0);
    expect(Number(invoice!.total)).toBe(700);
    expect(invoice!.items[0]).toMatchObject({ taxCategory: 'E1' });
    expect(Number(invoice!.items[0]!.taxRate)).toBe(0);

    // Quitar el extra no impide volver a guardar una vivienda que ya lo era.
    await setTenantFeatureOverride(owner.slug, 'housing', false);
    await request(app.getHttpServer())
      .patch(`/unit-types/${unitTypeId}`)
      .set(auth)
      .send({ propertyKind: 'housing', name: 'Piso 1' })
      .expect(200);
  });
});
