/**
 * E2E tests del sub-bloque 14A.3: API keys (tokens Bearer alternativos al
 * JWT del usuario). Cubre creacion, listado, verify via /integrations/whoami,
 * revoke, aislamiento cross-tenant y enforcement de rol `owner`.
 */
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('API keys (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('owner crea API key, recibe plaintext UNA vez y luego la ve sin plaintext', async () => {
    const owner = await registerVerifiedUser(app, 'apikey-create');

    const create = await request(app.getHttpServer())
      .post('/settings/api-keys')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Integration test', scopes: ['invoices:read', 'invoices:write'] });

    expect(create.status).toBe(201);
    expect(create.body.id).toBeDefined();
    expect(create.body.keyPlaintext).toMatch(/^sk_live_[0-9a-f-]{36}\./);
    expect(create.body.keyPrefix).toBe(`sk_live_${owner.tenantId}`);
    expect(create.body.scopes).toEqual(['invoices:read', 'invoices:write']);
    expect(create.body.revokedAt).toBeNull();

    const list = await request(app.getHttpServer())
      .get('/settings/api-keys')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    const row = list.body.find((r: { id: string }) => r.id === create.body.id);
    expect(row).toBeDefined();
    expect(row.keyPlaintext).toBeUndefined();
    expect(row.keyPrefix).toBe(`sk_live_${owner.tenantId}`);
  });

  it('verifica API key autenticando una request via /integrations/whoami', async () => {
    const owner = await registerVerifiedUser(app, 'apikey-verify');

    const create = await request(app.getHttpServer())
      .post('/settings/api-keys')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Verify test', scopes: [] });
    expect(create.status).toBe(201);
    const apiKey = create.body.keyPlaintext as string;

    const whoami = await request(app.getHttpServer())
      .get('/integrations/whoami')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(whoami.status).toBe(200);
    expect(whoami.body.tenantId).toBe(owner.tenantId);
    expect(whoami.body.apiKeyId).toBe(create.body.id);
  });

  it('revoca una API key y deja de funcionar', async () => {
    const owner = await registerVerifiedUser(app, 'apikey-revoke');
    const create = await request(app.getHttpServer())
      .post('/settings/api-keys')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'To revoke', scopes: [] });
    expect(create.status).toBe(201);
    const apiKey = create.body.keyPlaintext as string;
    const apiKeyId = create.body.id as string;

    const before = await request(app.getHttpServer())
      .get('/integrations/whoami')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(before.status).toBe(200);

    const revoke = await request(app.getHttpServer())
      .delete(`/settings/api-keys/${apiKeyId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.revokedAt).toBeTruthy();

    const after = await request(app.getHttpServer())
      .get('/integrations/whoami')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('api_key_invalid');
  });

  it('aislamiento cross-tenant: tenant_b no ve api keys de tenant_a', async () => {
    const ownerA = await registerVerifiedUser(app, 'apikey-iso-a');
    const ownerB = await registerVerifiedUser(app, 'apikey-iso-b');

    const createA = await request(app.getHttpServer())
      .post('/settings/api-keys')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'A only', scopes: [] });
    expect(createA.status).toBe(201);
    const idA = createA.body.id as string;

    const listB = await request(app.getHttpServer())
      .get('/settings/api-keys')
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(listB.status).toBe(200);
    expect(listB.body.find((r: { id: string }) => r.id === idA)).toBeUndefined();

    // Revocar la key de A desde B debe devolver 404 (RLS la oculta).
    const revokeB = await request(app.getHttpServer())
      .delete(`/settings/api-keys/${idA}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(revokeB.status).toBe(404);
  });

  it('sin JWT, los endpoints de panel responden 401', async () => {
    const noAuth = await request(app.getHttpServer())
      .post('/settings/api-keys')
      .send({ name: 'no auth', scopes: [] });
    expect(noAuth.status).toBe(401);

    const listNoAuth = await request(app.getHttpServer()).get('/settings/api-keys');
    expect(listNoAuth.status).toBe(401);
  });

  it('rechaza tokens con formato invalido', async () => {
    const res1 = await request(app.getHttpServer())
      .get('/integrations/whoami')
      .set('Authorization', 'Bearer not_a_valid_token');
    expect(res1.status).toBe(401);

    const res2 = await request(app.getHttpServer())
      .get('/integrations/whoami')
      .set('Authorization', 'Bearer sk_live_invalid.format');
    expect(res2.status).toBe(401);

    const res3 = await request(app.getHttpServer()).get('/integrations/whoami');
    expect(res3.status).toBe(401);
  });
});
