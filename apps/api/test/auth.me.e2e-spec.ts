import request from 'supertest';

import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('GET /auth/me (e2e)', () => {
  let app: INestApplication;
  const password = 'Secret123';
  let slug: string;
  let email: string;
  let accessTokenA: string;
  let tenantBSlug: string;
  let userBAccessToken: string;
  let userBUserId: string;
  let userAUserId: string;
  let tenantAId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();

    // Tenant A
    const idsA = uniqueTestIds('me-a');
    slug = idsA.slug;
    email = idsA.email;
    const a = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Test Me A',
      tenantSlug: slug,
      fullName: 'User A',
      email,
      password,
      acceptTerms: true,
    });
    expect(a.status).toBe(201);
    accessTokenA = a.body.accessToken;
    userAUserId = a.body.user.id;
    tenantAId = a.body.tenant.id;

    // Tenant B (para probar aislamiento RLS)
    const idsB = uniqueTestIds('me-b');
    tenantBSlug = idsB.slug;
    const b = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Test Me B',
      tenantSlug: tenantBSlug,
      fullName: 'User B',
      email: idsB.email,
      password,
      acceptTerms: true,
    });
    expect(b.status).toBe(201);
    userBAccessToken = b.body.accessToken;
    userBUserId = b.body.user.id;
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve user + tenant + subscription del usuario autenticado', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessTokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userAUserId);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.tenant.id).toBe(tenantAId);
    expect(res.body.tenant.slug).toBe(slug);
    expect(res.body.subscription.status).toBe('trial');
    expect(res.body.subscription.planSlug).toBe('starter');
  });

  it('rechaza con 401 sin token', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('rechaza con 401 con token malformado', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('cada user solo ve su propio tenant (aislamiento RLS via JWT)', async () => {
    const resA = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessTokenA}`);
    const resB = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${userBAccessToken}`);
    expect(resA.body.tenant.id).not.toBe(resB.body.tenant.id);
    expect(resA.body.user.id).toBe(userAUserId);
    expect(resB.body.user.id).toBe(userBUserId);
  });
});
