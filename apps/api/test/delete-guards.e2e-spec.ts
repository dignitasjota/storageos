import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Borrar un trastero con historia o un local con contratos en vigor: 409 claro, no un 500. */
describe('Borrado de trasteros y locales con contratos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('no deja borrar un trastero con contratos ni un local con contratos en vigor', async () => {
    const owner = await registerVerifiedUser(app, 'delguard');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
    });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], priceMonthly: 50, startDate: '2026-01-01' })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).expect(200);

    const facility = await http().delete(`/facilities/${facilityId}`).set(auth);
    expect(facility.status).toBe(409);
    expect(facility.body.code).toBe('facility_has_live_contracts');

    // Finalizado: el trastero queda libre pero con historia → no se borra.
    await http().post(`/contracts/${contract.body.id}/end`).set(auth).expect(200);
    const unit = await http().delete(`/units/${unitIds[0]}`).set(auth);
    expect(unit.status).toBe(409);
    expect(unit.body.code).toBe('unit_has_history');

    // Uno sin historia sí se borra, y el local ya también.
    await http().delete(`/units/${unitIds[1]}`).set(auth).expect(204);
    await http().delete(`/facilities/${facilityId}`).set(auth).expect(204);
  });
});
