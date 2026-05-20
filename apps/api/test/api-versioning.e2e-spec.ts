import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Cubre el sub-bloque 13A.2: versioning URI `/v1/` + redirect 308 desde
 * rutas legacy. Levantamos el app con `rewriteLegacyToV1: false` para
 * que el `LegacyRedirectMiddleware` real responda y podamos verificar
 * el redirect (en el resto de suites el helper hace rewrite in-place
 * para evitar reescribir 30 specs).
 */
describe('API versioning + legacy redirect (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp({ rewriteLegacyToV1: false });
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('GET /auth/me sin prefijo devuelve 308 + Location /v1/auth/me', async () => {
    const owner = await registerVerifiedUser(app, 'ver-redirect');

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .redirects(0);

    expect(res.status).toBe(308);
    expect(res.headers.location).toBe('/v1/auth/me');
  });

  it('GET /v1/auth/me con bearer devuelve 200 sin redirect', async () => {
    const owner = await registerVerifiedUser(app, 'ver-v1');

    const res = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .redirects(0);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(owner.email);
  });

  it('GET /health responde 200 sin redirect (VERSION_NEUTRAL)', async () => {
    const res = await request(app.getHttpServer()).get('/health').redirects(0);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  // /v1/health y /api/docs-json son responsabilidad del bootstrap (main.ts)
  // y no del helper createTestApp. No se cubren aqui.

  it('POST /auth/login sin prefijo: el cliente que sigue redirects recibe 308 -> /v1/auth/login y procesa el login', async () => {
    // Verifica el escenario real de un cliente HTTP que respeta 308:
    // supertest con `.redirects(1)` retiene el metodo POST + body por
    // semantica del 308 (a diferencia de 302/303 que lo cambiarian a GET).
    const owner = await registerVerifiedUser(app, 'ver-redir-post');

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        tenantSlug: owner.slug,
        email: owner.email,
        password: owner.password,
      })
      .redirects(1);

    // Tras seguir el 308, llegamos al login real -> 200 con accessToken.
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });
});
