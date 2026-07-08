import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Anti-doble-ocupación: dos contratos no pueden quedar activos en el mismo
 * trastero (advisory lock + índice único parcial `contracts_one_active_per_unit`).
 */
describe('Contrato: sin doble ocupación de trastero (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('no se pueden firmar dos contratos en el mismo trastero', async () => {
    const owner = await registerVerifiedUser(app, 'dblocc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const unitId = unitIds[0]!;
    const custA = await createCustomer(app, owner.accessToken);
    const custB = await createCustomer(app, owner.accessToken);

    // Dos contratos DRAFT sobre el mismo trastero (permitido en borrador).
    const mkDraft = async (customerId: string): Promise<string> => {
      const c = await request(app.getHttpServer()).post('/contracts').set(auth).send({
        customerId,
        unitId,
        startDate: '2026-05-01',
        priceMonthly: 50,
        depositAmount: 0,
      });
      expect(c.status).toBe(201);
      return c.body.id as string;
    };
    const c1 = await mkDraft(custA);
    const c2 = await mkDraft(custB);

    // Firmar el primero → activo, trastero ocupado.
    await request(app.getHttpServer()).post(`/contracts/${c1}/sign`).set(auth).expect(200);

    // Firmar el segundo en el MISMO trastero → 409 (ya está ocupado).
    const second = await request(app.getHttpServer()).post(`/contracts/${c2}/sign`).set(auth);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('unit_not_available');
  });
});
