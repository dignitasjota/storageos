import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Holded settings (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('estado por defecto: deshabilitado, sin api key', async () => {
    const owner = await registerVerifiedUser(app, 'holded-default');
    const res = await request(app.getHttpServer())
      .get('/settings/holded')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, hasApiKey: false });
  });

  it('activar sin api key → 400', async () => {
    const owner = await registerVerifiedUser(app, 'holded-nokey');
    const res = await request(app.getHttpServer())
      .put('/settings/holded')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it('guardar api key + activar → hasApiKey true (la key nunca se devuelve)', async () => {
    const owner = await registerVerifiedUser(app, 'holded-set');
    const res = await request(app.getHttpServer())
      .put('/settings/holded')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ apiKey: 'k_live_abcdef123456', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.hasApiKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('k_live_abcdef123456');
  });

  it('sincronizar sin integración activa → 400', async () => {
    const owner = await registerVerifiedUser(app, 'holded-sync');
    // un id cualquiera válido (uuid) — falla antes por integración no activa
    const res = await request(app.getHttpServer())
      .post('/settings/holded/invoices/00000000-0000-7000-8000-000000000000/sync')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(400);
  });
});
