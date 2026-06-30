import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Registro de actividad del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('lista el audit log del tenant (owner) con cursor', async () => {
    const owner = await registerVerifiedUser(app, 'audit');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer()).get('/audit-logs').expect(401);

    const res = await request(app.getHttpServer()).get('/audit-logs').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    // El registro tiene al menos la acción de registro/login del propio onboarding.
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0]).toHaveProperty('action');
    expect(res.body.items[0]).toHaveProperty('createdAt');
    expect(res.body).toHaveProperty('nextCursor');
  });
});
