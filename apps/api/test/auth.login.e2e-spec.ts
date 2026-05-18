import request from 'supertest';

import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('POST /auth/login (e2e)', () => {
  let app: INestApplication;
  const password = 'Secret123';
  let slug: string;
  let email: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();

    const ids = uniqueTestIds('login');
    slug = ids.slug;
    email = ids.email;
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Test Login',
      tenantSlug: slug,
      fullName: 'Test',
      email,
      password,
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('login con credenciales validas devuelve tokens y cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: slug, email, password });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(typeof res.body.accessToken).toBe('string');
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
  });

  it('rechaza con 401 ante tenant inexistente (mensaje generico)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: 'test-nonexistent-tenant', email, password });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales invalidas');
  });

  it('rechaza con 401 ante email no registrado en el tenant', async () => {
    const ids = uniqueTestIds('other');
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: slug, email: ids.email, password });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales invalidas');
  });

  it('rechaza con 401 ante password incorrecta', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: slug, email, password: 'WrongPass1' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciales invalidas');
  });

  it.each([
    ['email mal formado', { email: 'no-es-email' }],
    ['tenantSlug invalido', { tenantSlug: '-bad' }],
    ['password vacia', { password: '' }],
  ])('devuelve 400 cuando %s', async (_label, override) => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: slug, email, password, ...override });
    expect(res.status).toBe(400);
  });
});
