import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Informe mensual por email al operador (digest del tenant): toggle opt-in +
 * «enviar ahora» a los propietarios.
 */
describe('Informe mensual del tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('opt-in + enviar ahora encola el email a los propietarios', async () => {
    const owner = await registerVerifiedUser(app, 'digest');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Por defecto desactivado.
    const before = await request(app.getHttpServer())
      .get('/settings/tenant/monthly-digest')
      .set(auth);
    expect(before.status).toBe(200);
    expect(before.body.enabled).toBe(false);

    // Activar.
    const on = await request(app.getHttpServer())
      .patch('/settings/tenant/monthly-digest')
      .set(auth)
      .send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);

    // Enviar ahora → hay 1 destinatario (el propietario verificado).
    const run = await request(app.getHttpServer())
      .post('/settings/tenant/monthly-digest/run')
      .set(auth);
    expect(run.status).toBe(201);
    expect(run.body.sent).toBe(true);
    expect(run.body.recipients).toBeGreaterThanOrEqual(1);

    // Persiste el estado.
    const after = await request(app.getHttpServer())
      .get('/settings/tenant/monthly-digest')
      .set(auth);
    expect(after.body.enabled).toBe(true);
  });

  it('sin autenticación → 401', async () => {
    await request(app.getHttpServer()).get('/settings/tenant/monthly-digest').expect(401);
  });
});
