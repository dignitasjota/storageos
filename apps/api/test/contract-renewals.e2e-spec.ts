import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Contratos por renovar (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve los contratos que vencen pronto', async () => {
    const owner = await registerVerifiedUser(app, 'renewals');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer()).get('/contracts/renewals').expect(401);

    const res = await request(app.getHttpServer()).get('/contracts/renewals').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true); // tenant nuevo → vacío
  });
});
