import { createHmac } from 'node:crypto';

import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('GoCardless settings + webhook (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('config cifrada (no devuelve secretos) + webhook firmado', async () => {
    const owner = await registerVerifiedUser(app, 'gocardless');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const webhookSecret = 'whsec_test_gocardless_123456';

    // Por defecto vacío.
    const before = await request(app.getHttpServer()).get('/settings/gocardless').set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      enabled: false,
      hasAccessToken: false,
      hasWebhookSecret: false,
    });

    // Guardar credenciales + activar.
    const save = await request(app.getHttpServer()).put('/settings/gocardless').set(auth).send({
      accessToken: 'sandbox_token_abcdef123456',
      webhookSecret,
      environment: 'sandbox',
      enabled: true,
    });
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({
      environment: 'sandbox',
      enabled: true,
      hasAccessToken: true,
      hasWebhookSecret: true,
    });
    // Nunca devuelve el token ni el secret en claro.
    expect(JSON.stringify(save.body)).not.toContain('sandbox_token');
    expect(JSON.stringify(save.body)).not.toContain(webhookSecret);

    // Webhook con firma VÁLIDA → 200.
    const body = JSON.stringify({ events: [{ id: 'EV1', action: 'created' }] });
    const sig = createHmac('sha256', webhookSecret).update(body).digest('hex');
    const ok = await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', sig)
      .send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });

    // Webhook con firma INVÁLIDA → 400.
    const bad = await request(app.getHttpServer())
      .post(`/webhooks/gocardless/${owner.tenantId}`)
      .set('Content-Type', 'application/json')
      .set('Webhook-Signature', 'deadbeef')
      .send(body);
    expect(bad.status).toBe(400);
  });

  it('no deja activar sin credenciales', async () => {
    const owner = await registerVerifiedUser(app, 'gocardless-noc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const res = await request(app.getHttpServer())
      .put('/settings/gocardless')
      .set(auth)
      .send({ environment: 'sandbox', enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('gocardless_credentials_required');
  });
});
