import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Sincronización de gasto publicitario (Google Ads / Meta Ads): CRUD de
 * credenciales (nunca se exponen), guardas de activación, vínculo del canal
 * a una campaña externa, y guardas del endpoint de sincronización manual.
 * No se ejercita una llamada real a las APIs externas (como Holded/Redsys/
 * GoCardless, no hay credenciales de prueba disponibles en CI).
 */
describe('Sincronización de gasto Google Ads / Meta Ads (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('Google Ads: estado por defecto, activar sin credenciales → 400, guardar → hasCredentials true sin exponer secretos', async () => {
    const owner = await registerVerifiedUser(app, 'ads-google');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const initial = await request(app.getHttpServer())
      .get('/settings/marketing/google-ads')
      .set(auth);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ enabled: false, hasCredentials: false });

    const activateBare = await request(app.getHttpServer())
      .put('/settings/marketing/google-ads')
      .set(auth)
      .send({ enabled: true });
    expect(activateBare.status).toBe(400);

    const withCreds = await request(app.getHttpServer())
      .put('/settings/marketing/google-ads')
      .set(auth)
      .send({
        clientId: 'client-abc',
        clientSecret: 'super-secret-1',
        developerToken: 'dev-token-1',
        refreshToken: 'refresh-token-1',
        customerId: '123-456-7890',
        enabled: true,
      });
    expect(withCreds.status).toBe(200);
    expect(withCreds.body).toMatchObject({
      enabled: true,
      hasCredentials: true,
      customerId: '123-456-7890',
    });
    expect(JSON.stringify(withCreds.body)).not.toContain('super-secret-1');
    expect(JSON.stringify(withCreds.body)).not.toContain('refresh-token-1');
  });

  it('Meta Ads: estado por defecto, activar sin credenciales → 400, guardar → hasAccessToken true', async () => {
    const owner = await registerVerifiedUser(app, 'ads-meta');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const initial = await request(app.getHttpServer())
      .get('/settings/marketing/meta-ads')
      .set(auth);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ enabled: false, hasAccessToken: false });

    const activateBare = await request(app.getHttpServer())
      .put('/settings/marketing/meta-ads')
      .set(auth)
      .send({ enabled: true });
    expect(activateBare.status).toBe(400);

    const withCreds = await request(app.getHttpServer())
      .put('/settings/marketing/meta-ads')
      .set(auth)
      .send({ accessToken: 'meta-token-xyz', adAccountId: '999888777', enabled: true });
    expect(withCreds.status).toBe(200);
    expect(withCreds.body).toMatchObject({
      enabled: true,
      hasAccessToken: true,
      adAccountId: '999888777',
    });
    expect(JSON.stringify(withCreds.body)).not.toContain('meta-token-xyz');
  });

  it('un canal se vincula a una campaña externa; sincronizar sin campaña o sin integración activa → 400', async () => {
    const owner = await registerVerifiedUser(app, 'ads-channel');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Canal Google Ads sin campaña vinculada → sync 400.
    const noCampaign = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'google_ads', name: 'SEM genérico' });
    expect(noCampaign.status).toBe(201);
    expect(noCampaign.body.externalCampaignId).toBeNull();

    const syncNoCampaign = await request(app.getHttpServer())
      .post(`/marketing/channels/${noCampaign.body.id}/sync-ad-spend`)
      .set(auth)
      .send({});
    expect(syncNoCampaign.status).toBe(400);
    expect(syncNoCampaign.body.code).toBe('no_external_campaign');

    // Vincula la campaña — la integración de Google Ads sigue sin activar → 400.
    const linked = await request(app.getHttpServer())
      .patch(`/marketing/channels/${noCampaign.body.id}`)
      .set(auth)
      .send({ externalCampaignId: '111222333' });
    expect(linked.status).toBe(200);
    expect(linked.body.externalCampaignId).toBe('111222333');

    const syncNotEnabled = await request(app.getHttpServer())
      .post(`/marketing/channels/${noCampaign.body.id}/sync-ad-spend`)
      .set(auth)
      .send({});
    expect(syncNotEnabled.status).toBe(400);
    expect(syncNotEnabled.body.code).toBe('google_ads_not_enabled');

    // Canal de un tipo sin plataforma de anuncios soportada, con campaña → 400 distinto.
    const otherType = await request(app.getHttpServer())
      .post('/marketing/channels')
      .set(auth)
      .send({ type: 'physical', name: 'Cartel', externalCampaignId: '1' });
    const syncUnsupported = await request(app.getHttpServer())
      .post(`/marketing/channels/${otherType.body.id}/sync-ad-spend`)
      .set(auth)
      .send({});
    expect(syncUnsupported.status).toBe(400);
    expect(syncUnsupported.body.code).toBe('unsupported_platform');

    // Canal inexistente → 404.
    await request(app.getHttpServer())
      .post('/marketing/channels/00000000-0000-7000-8000-000000000000/sync-ad-spend')
      .set(auth)
      .send({})
      .expect(404);
  });

  it('sin autenticación → 401', async () => {
    await request(app.getHttpServer()).get('/settings/marketing/google-ads').expect(401);
    await request(app.getHttpServer()).get('/settings/marketing/meta-ads').expect(401);
  });
});
