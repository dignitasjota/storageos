import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * «Sugerir respuesta» del staff en el chat con un inquilino (IA, provider stub).
 * Redacta un borrador a partir del hilo + los datos del cliente; no lo envía.
 */
describe('IA: sugerir respuesta en el chat (e2e, stub)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve un borrador; requiere la feature ai_assistant', async () => {
    const owner = await registerVerifiedUser(app, 'ai-suggest');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    // Sin la feature (plan starter) → 403.
    await request(app.getHttpServer())
      .post('/ai/suggest-reply')
      .set(auth)
      .send({ customerId })
      .expect(403);

    // Con la feature (pro) → devuelve un texto sugerido.
    await setTenantPlan(owner.slug, 'pro');

    // El inquilino escribe algo en el chat (para que haya hilo).
    await request(app.getHttpServer())
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: '¿Cuándo puedo pasar a recoger mis cosas?' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/ai/suggest-reply')
      .set(auth)
      .send({ customerId });
    expect(res.status).toBe(200);
    expect(typeof res.body.suggestion).toBe('string');
    expect(res.body.suggestion.length).toBeGreaterThan(0);

    // Cliente inexistente → 404.
    await request(app.getHttpServer())
      .post('/ai/suggest-reply')
      .set(auth)
      .send({ customerId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });

  it('sin autenticación → 401', async () => {
    await request(app.getHttpServer())
      .post('/ai/suggest-reply')
      .send({ customerId: '00000000-0000-0000-0000-000000000000' })
      .expect(401);
  });
});
