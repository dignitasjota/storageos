import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Cabecera de «Hoy»: cifras del mes y actividad de las últimas 48 h. */
describe('Hoy: cifras y actividad (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('cuenta ocupación, altas y actividad reciente', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'todaysum');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const empty = await http().get('/dashboard/today/summary').set(auth).expect(200);
    expect(empty.body.kpis).toMatchObject({ totalUnits: 0, occupancyPct: 0, moveInsMonth: 0 });
    expect(empty.body.activity).toEqual([]);

    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Lola' });
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 40 })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);
    await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Nuevo', lastName: 'Contacto', email: 'nuevo@example.com', source: 'web' })
      .expect(201);

    const res = await http().get('/dashboard/today/summary').set(auth).expect(200);
    expect(res.body.kpis).toMatchObject({
      totalUnits: 2,
      freeUnits: 1,
      occupancyPct: 50,
      moveInsMonth: 1,
    });
    const kinds = res.body.activity.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['contract_signed', 'lead_created']));
    const signed = res.body.activity.find((a: { kind: string }) => a.kind === 'contract_signed');
    expect(signed.href).toBe(`/contracts/${contract.body.id}`);

    await http().get('/dashboard/today/summary?facilityId=nope').set(auth).expect(400);
    await http().get('/dashboard/today/summary').expect(401);
  });
});
