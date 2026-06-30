import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Calendario operativo (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve eventos del rango y valida el rango', async () => {
    const owner = await registerVerifiedUser(app, 'calendar');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer()).get('/calendar?from=2026-06-01&to=2026-06-30').expect(401);

    const res = await request(app.getHttpServer())
      .get('/calendar?from=2026-06-01&to=2026-06-30')
      .set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true); // tenant nuevo → vacío

    // Rango invertido → 400.
    const bad = await request(app.getHttpServer())
      .get('/calendar?from=2026-06-30&to=2026-06-01')
      .set(auth);
    expect(bad.status).toBe(400);

    // Rango demasiado amplio → 400.
    const wide = await request(app.getHttpServer())
      .get('/calendar?from=2026-01-01&to=2026-12-31')
      .set(auth);
    expect(wide.status).toBe(400);
  });
});
