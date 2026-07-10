import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Unicidad de PIN: dos credenciales con el mismo PIN abrirían con la credencial
 * (y sus restricciones) equivocada, porque `verify` devuelve la primera que
 * casa. El alta con un PIN ya en uso → 409.
 */
describe('Unicidad de PIN de credenciales (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un PIN ya en uso en el tenant → 409; otro distinto → 201', async () => {
    const owner = await registerVerifiedUser(app, 'pinuniq');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const c1 = await createCustomer(app, owner.accessToken);
    const c2 = await createCustomer(app, owner.accessToken);

    const first = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId: c1, method: 'pin', pin: '112233', allowedHours: {} });
    expect(first.status).toBe(201);

    // Mismo PIN (otro inquilino) → colisión → 409.
    const dup = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId: c2, method: 'pin', pin: '112233', allowedHours: {} });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('pin_collision');

    // PIN distinto → OK.
    const ok = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId: c2, method: 'pin', pin: '445566', allowedHours: {} });
    expect(ok.status).toBe(201);
  });
});
