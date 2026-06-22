import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Campaigns win-back (segmento former) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function createCustomer(auth: object, email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'C', lastName: email, email, country: 'ES' })
      .expect(201);
    return res.body.id as string;
  }

  async function signedContract(auth: object, customerId: string, unitId: string): Promise<string> {
    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: '2026-01-01', priceMonthly: 80, depositAmount: 0 });
    const id = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${id}/sign`).set(auth).expect(200);
    return id;
  }

  it('el segmento former incluye solo ex-clientes (contrato finalizado, sin activo)', async () => {
    const owner = await registerVerifiedUser(app, 'winback');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });

    // A: contrato finalizado → ex-cliente.
    const formerId = await createCustomer(auth, 'former@e2e.local');
    const formerContract = await signedContract(auth, formerId, unitIds[0]!);
    await request(app.getHttpServer())
      .post(`/contracts/${formerContract}/end`)
      .set(auth)
      .expect(200);

    // B: contrato activo → cliente actual (no win-back).
    const activeId = await createCustomer(auth, 'active@e2e.local');
    await signedContract(auth, activeId, unitIds[1]!);

    // C: sin contrato (nunca lo tuvo) → no es win-back.
    await createCustomer(auth, 'nocontract@e2e.local');

    // Preview win-back → solo A.
    const former = await request(app.getHttpServer())
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', contractStatus: 'former' } });
    expect(former.status).toBe(200);
    expect(former.body.audienceCount).toBe(1);

    // Sanity: activos = solo B.
    const active = await request(app.getHttpServer())
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', contractStatus: 'active' } });
    expect(active.body.audienceCount).toBe(1);
  });
});
