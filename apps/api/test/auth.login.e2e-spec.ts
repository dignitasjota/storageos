import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('POST /auth/login (e2e)', () => {
  let app: INestApplication;
  let slug: string;
  let email: string;
  let password: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    const user = await registerVerifiedUser(app, 'login');
    slug = user.slug;
    email = user.email;
    password = user.password;
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
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

  it('rechaza con 403 + code email_not_verified si el user aun no verifico', async () => {
    const ids = uniqueTestIds('login-unverified');
    const reg = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Login Unverified',
      tenantSlug: ids.slug,
      fullName: 'Unverified User',
      email: ids.email,
      password: 'Secret123',
      acceptTerms: true,
    });
    expect(reg.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: ids.slug, email: ids.email, password: 'Secret123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('email_not_verified');
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
