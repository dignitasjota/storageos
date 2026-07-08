import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Ciclo de vida de la fianza: se marca `held` al firmar, y se liquida al
 * finalizar (devolución total/parcial con retención por daños/deuda).
 */
describe('Liquidación de fianza (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('firma → held; liquidación parcial → partially_returned con retención', async () => {
    const owner = await registerVerifiedUser(app, 'deposit');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Contrato con fianza de 100 €.
    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 60,
      depositAmount: 100,
    });
    expect(create.status).toBe(201);
    const contractId = create.body.id as string;
    // Antes de firmar la fianza está `none`.
    expect(create.body.depositStatus).toBe('none');

    // Al firmar → la fianza queda RETENIDA.
    const signed = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/sign`)
      .set(auth)
      .expect(200);
    expect(signed.body.depositStatus).toBe('held');

    // Liquidar sin motivo reteniendo → 400 (motivo obligatorio).
    const noReason = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 70 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('retention_reason_required');

    // Importe fuera de rango → 400.
    const tooMuch = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 150 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.code).toBe('invalid_return_amount');

    // Liquidación parcial: devuelve 70, retiene 30 por daños.
    const settled = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 70, retentionReason: 'Daños en la puerta' });
    expect(settled.status).toBe(200);
    expect(settled.body.depositStatus).toBe('partially_returned');
    expect(settled.body.depositReturnedAmount).toBe(70);
    expect(settled.body.depositRetentionReason).toBe('Daños en la puerta');
    expect(settled.body.depositSettledAt).toBeTruthy();

    // Re-liquidar → 400 (ya no está held).
    const again = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 30, retentionReason: 'x' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('deposit_not_held');
  });

  it('liquidación total → returned sin motivo', async () => {
    const owner = await registerVerifiedUser(app, 'deposit-full');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    const create = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 60,
      depositAmount: 80,
    });
    const contractId = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${contractId}/sign`).set(auth).expect(200);

    const settled = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 80 });
    expect(settled.status).toBe(200);
    expect(settled.body.depositStatus).toBe('returned');
    expect(settled.body.depositReturnedAmount).toBe(80);
    expect(settled.body.depositRetentionReason).toBeNull();
  });
});
