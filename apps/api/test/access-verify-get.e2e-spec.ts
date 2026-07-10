import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * `GET /access/verify` — variante para lectores comerciales que integran por
 * "URL con placeholders" (Akuvox modo servidor de terceros, escáneres QR/
 * Wiegand→HTTP). Mismos datos que el POST pero por query; API key por header o
 * `?key=`.
 */
describe('GET /access/verify (adaptador para lectores por URL) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('valida un PIN por GET con la key en query; PIN erróneo deniega; sin key 401', async () => {
    const owner = await registerVerifiedUser(app, 'verifyget');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local GET', country: 'ES' });
    const device = await request(app.getHttpServer()).post('/access/devices').set(auth).send({
      facilityId: facility.body.id,
      type: 'gate',
      name: 'Cancela',
      hardwareId: 'get-dev-1',
    });
    const apiKey = device.body.revealedApiKey as string;
    const customerId = await createCustomer(app, owner.accessToken);
    await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin', pin: '481902', allowedHours: {} })
      .expect(201);

    // PIN correcto (key por query, method inferido de ?pin=).
    const ok = await request(app.getHttpServer())
      .get('/access/verify')
      .query({ key: apiKey, device: 'get-dev-1', pin: '481902' });
    expect(ok.status).toBe(200);
    expect(ok.body.allowed).toBe(true);

    // PIN incorrecto → denegado.
    const bad = await request(app.getHttpServer())
      .get('/access/verify')
      .query({ key: apiKey, device: 'get-dev-1', pin: '000000' });
    expect(bad.status).toBe(200);
    expect(bad.body.allowed).toBe(false);

    // Sin API key → 401.
    const noKey = await request(app.getHttpServer())
      .get('/access/verify')
      .query({ device: 'get-dev-1', pin: '481902' });
    expect(noKey.status).toBe(401);

    // La key también se acepta por header X-Device-Key.
    const viaHeader = await request(app.getHttpServer())
      .get('/access/verify')
      .set('X-Device-Key', apiKey)
      .query({ device: 'get-dev-1', pin: '481902' });
    expect(viaHeader.body.allowed).toBe(true);
  });
});
