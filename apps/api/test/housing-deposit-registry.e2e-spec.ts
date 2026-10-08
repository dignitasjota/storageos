import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Fianza de vivienda depositada en el organismo autonómico. */
describe('Depósito de la fianza de vivienda (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('avisa en Hoy hasta registrar el depósito y solo aplica a viviendas', async () => {
    const owner = await registerVerifiedUser(app, 'depreg');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'housing', true);
    const housing = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 700,
    });
    const storage = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });
    await request(app.getHttpServer())
      .patch(`/unit-types/${housing.unitTypeId}`)
      .set(auth)
      .send({ propertyKind: 'housing' })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken);
    const sign = async (unitId: string, deposit: number) => {
      const c = await request(app.getHttpServer()).post('/contracts').set(auth).send({
        customerId,
        unitId,
        startDate: '2026-02-01',
        priceMonthly: 700,
        depositAmount: deposit,
      });
      await request(app.getHttpServer())
        .post(`/contracts/${c.body.id}/sign`)
        .set(auth)
        .send({})
        .expect(200);
      return c.body.id as string;
    };
    const flat = await sign(housing.unitIds[0]!, 700);
    const box = await sign(storage.unitIds[0]!, 50);

    const today = await request(app.getHttpServer()).get('/dashboard/today').set(auth);
    expect(today.body.depositsToRegister.count).toBe(1);
    expect(today.body.depositsToRegister.items[0].id).toBe(flat);

    // Un trastero no lleva depósito en el organismo.
    await request(app.getHttpServer())
      .put(`/contracts/${box}/deposit-registry`)
      .set(auth)
      .send({ body: 'INCASÒL', registeredAt: '2026-02-10' })
      .expect(400);
    // Justificante de otro contrato: rechazado.
    await request(app.getHttpServer())
      .put(`/contracts/${flat}/deposit-registry`)
      .set(auth)
      .send({ body: 'INCASÒL', registeredAt: '2026-02-10', receiptKey: 'otro/fichero.pdf' })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/contracts/${flat}/deposit-registry/receipt`)
      .set(auth)
      .expect(404);

    const upload = await request(app.getHttpServer())
      .post(`/contracts/${flat}/deposit-registry/receipt-upload-url`)
      .set(auth)
      .send({ mimeType: 'application/pdf' })
      .expect(201);
    const saved = await request(app.getHttpServer())
      .put(`/contracts/${flat}/deposit-registry`)
      .set(auth)
      .send({
        body: 'INCASÒL',
        registeredAt: '2026-02-10',
        reference: 'R-2026-0042',
        receiptKey: upload.body.key,
      });
    expect(saved.status).toBe(200);
    expect(saved.body.propertyKind).toBe('housing');
    expect(saved.body.depositRegistry).toEqual({
      body: 'INCASÒL',
      registeredAt: '2026-02-10',
      reference: 'R-2026-0042',
      hasReceipt: true,
      recoveredAt: null,
    });
    const receipt = await request(app.getHttpServer())
      .get(`/contracts/${flat}/deposit-registry/receipt`)
      .set(auth)
      .expect(200);
    expect(receipt.body.url).toContain('deposit-registry');

    const after = await request(app.getHttpServer()).get('/dashboard/today').set(auth);
    expect(after.body.depositsToRegister.count).toBe(0);
  });
});
