import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const FROM = '2026-08-01T00:00:00.000Z';
const UNTIL = '2026-08-31T00:00:00.000Z';

describe('Reservations + EXCLUDE constraint (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('crea reserva pending; confirm pone unit en reserved', async () => {
    const owner = await registerVerifiedUser(app, 'res-create');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    const create = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        unitId: unitIds[0],
        customerId,
        validFrom: FROM,
        validUntil: UNTIL,
        depositAmount: 30,
      });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('pending');

    const confirm = await request(app.getHttpServer())
      .post(`/reservations/${create.body.id}/confirm`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('confirmed');

    const unit = await request(app.getHttpServer())
      .get(`/units/${unitIds[0]}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(unit.body.status).toBe('reserved');
  });

  it('EXCLUDE constraint impide overlap pending/confirmed sobre mismo unit', async () => {
    const owner = await registerVerifiedUser(app, 'res-overlap');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    const r1 = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ unitId: unitIds[0], customerId, validFrom: FROM, validUntil: UNTIL });
    expect(r1.status).toBe(201);

    // Solapamiento total
    const r2 = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ unitId: unitIds[0], customerId, validFrom: FROM, validUntil: UNTIL });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('reservation_overlap');

    // Solapamiento parcial
    const r3 = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        unitId: unitIds[0],
        customerId,
        validFrom: '2026-08-15T00:00:00.000Z',
        validUntil: '2026-09-15T00:00:00.000Z',
      });
    expect(r3.status).toBe(409);

    // Cancelar la primera permite crear nueva en ese rango
    const cancel = await request(app.getHttpServer())
      .post(`/reservations/${r1.body.id}/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'libera' });
    expect(cancel.status).toBe(200);

    const r4 = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ unitId: unitIds[0], customerId, validFrom: FROM, validUntil: UNTIL });
    expect(r4.status).toBe(201);
  });

  it('convert-to-contract crea contrato y marca reserva converted', async () => {
    const owner = await registerVerifiedUser(app, 'res-convert');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const r = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ unitId: unitIds[0], customerId, validFrom: FROM, validUntil: UNTIL });
    await request(app.getHttpServer())
      .post(`/reservations/${r.body.id}/confirm`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const conv = await request(app.getHttpServer())
      .post(`/reservations/${r.body.id}/convert-to-contract`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        startDate: '2026-08-01',
        priceMonthly: 80,
        discountAmount: 0,
        depositAmount: 30,
        billingCycle: 'monthly',
      });
    expect(conv.status).toBe(200);
    expect(conv.body.status).toBe('draft');
    expect(conv.body.unitId).toBe(unitIds[0]);

    const resAfter = await request(app.getHttpServer())
      .get(`/reservations/${r.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(resAfter.body.status).toBe('converted');
    expect(resAfter.body.convertedContractId).toBe(conv.body.id);
  });

  it('validUntil <= validFrom -> 400', async () => {
    const owner = await registerVerifiedUser(app, 'res-bad-range');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const res = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ unitId: unitIds[0], validFrom: UNTIL, validUntil: FROM });
    expect(res.status).toBe(400);
  });
});
