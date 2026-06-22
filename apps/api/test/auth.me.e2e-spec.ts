import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('GET /auth/me (e2e)', () => {
  let app: INestApplication;
  let slugA: string;
  let emailA: string;
  let accessTokenA: string;
  let userAUserId: string;
  let tenantAId: string;
  let userBAccessToken: string;
  let userBUserId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();

    const userA = await registerVerifiedUser(app, 'me-a', { fullName: 'User A' });
    slugA = userA.slug;
    emailA = userA.email;
    accessTokenA = userA.accessToken;
    userAUserId = userA.userId;
    tenantAId = userA.tenantId;

    const userB = await registerVerifiedUser(app, 'me-b', { fullName: 'User B' });
    userBAccessToken = userB.accessToken;
    userBUserId = userB.userId;
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('devuelve user + tenant + subscription del usuario autenticado', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessTokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userAUserId);
    expect(res.body.user.email).toBe(emailA);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.tenant.id).toBe(tenantAId);
    expect(res.body.tenant.slug).toBe(slugA);
    expect(res.body.subscription.status).toBe('trial');
    expect(res.body.subscription.planSlug).toBe('starter');
    // Gating por plan: el plan `starter` incluye estas features premium...
    expect(res.body.features).toEqual(
      expect.arrayContaining(['rent_increases', 'insurance', 'access_control', 'automations']),
    );
    // ...pero NO las de plan superior (IA / pagos avanzados).
    expect(res.body.features).not.toContain('ai_assistant');
    expect(res.body.features).not.toContain('sepa');
    expect(res.body.features).not.toContain('bank_reconciliation');
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
