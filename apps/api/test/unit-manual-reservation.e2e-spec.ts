import request from 'supertest';

import { ReservationsService } from '../src/modules/contracts/reservations.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const DAY = 86_400_000;

/**
 * Reserva manual del trastero para un cliente (confirmImmediately) → el trastero
 * pasa a `reserved`; liberar/expirar lo devuelve a `available`.
 */
describe('Trastero: reserva manual para un cliente (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('reserva directa → reserved; liberar → available', async () => {
    const owner = await registerVerifiedUser(app, 'manualresv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const unitId = unitIds[0]!;
    const customerId = await createCustomer(app, owner.accessToken);

    // Reserva manual directa: el trastero queda reserved en un solo paso.
    const res = await request(app.getHttpServer())
      .post('/reservations')
      .set(auth)
      .send({
        unitId,
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 7 * DAY).toISOString(),
        confirmImmediately: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');

    const unitAfter = await request(app.getHttpServer()).get(`/units/${unitId}`).set(auth);
    expect(unitAfter.body.status).toBe('reserved');

    // Liberar (cancelar) → vuelve a disponible.
    await request(app.getHttpServer())
      .post(`/reservations/${res.body.id}/cancel`)
      .set(auth)
      .send({ reason: 'test' })
      .expect(200);
    const unitFree = await request(app.getHttpServer()).get(`/units/${unitId}`).set(auth);
    expect(unitFree.body.status).toBe('available');
  });

  it('una reserva caducada libera el trastero automáticamente (cron)', async () => {
    const owner = await registerVerifiedUser(app, 'expiresv');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const unitId = unitIds[0]!;
    const customerId = await createCustomer(app, owner.accessToken);

    // Reserva ya vencida (validUntil en el pasado) → reserved.
    const res = await request(app.getHttpServer())
      .post('/reservations')
      .set(auth)
      .send({
        unitId,
        customerId,
        validFrom: new Date(Date.now() - 2 * DAY).toISOString(),
        validUntil: new Date(Date.now() - DAY).toISOString(),
        confirmImmediately: true,
      });
    expect(res.status).toBe(201);
    const reserved = await request(app.getHttpServer()).get(`/units/${unitId}`).set(auth);
    expect(reserved.body.status).toBe('reserved');

    // El cron cross-tenant caduca la reserva y libera el trastero.
    const result = await app.get(ReservationsService).expireDueAll();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const freed = await request(app.getHttpServer()).get(`/units/${unitId}`).set(auth);
    expect(freed.body.status).toBe('available');
  });
});
