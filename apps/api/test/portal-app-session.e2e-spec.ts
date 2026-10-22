import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const HOURS_48 = 48 * 60 * 60;
const DAYS_30 = 30 * 24 * 60 * 60;

/** Segundos de vida que le quedan al token (claim `exp` del JWT). */
function secondsLeft(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  return payload.exp - Math.floor(Date.now() / 1000);
}

describe('Sesión del portal con la app instalada (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  async function magicToken(staffToken: string, customerId: string): Promise<string> {
    const gen = await http()
      .post(`/customers/${customerId}/portal-link`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .expect(201);
    return gen.body.url.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)![1]!;
  }

  it('dura 48 h en el navegador y 30 días en la app, que la renueva al abrirse', async () => {
    const owner = await registerVerifiedUser(app, 'appsession');
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `appsession-${Date.now()}@e2e.local`,
    });

    // Navegador: 48 h, como hasta ahora.
    const browser = await http()
      .post('/portal/login/consume')
      .send({ token: await magicToken(owner.accessToken, customerId) })
      .expect(200);
    expect(browser.body.expiresIn).toBe(HOURS_48);
    expect(secondsLeft(browser.body.accessToken)).toBeLessThanOrEqual(HOURS_48);

    // App instalada: 30 días.
    const installed = await http()
      .post('/portal/login/consume')
      .send({ token: await magicToken(owner.accessToken, customerId), installedApp: true })
      .expect(200);
    expect(installed.body.expiresIn).toBe(DAYS_30);
    expect(secondsLeft(installed.body.accessToken)).toBeGreaterThan(DAYS_30 - 60);

    // Al abrirse, la app pide otra de 30 días con la que tiene.
    const renewed = await http()
      .post('/portal/me/session/renew')
      .set({ Authorization: `Bearer ${installed.body.accessToken}` })
      .send({ installedApp: true })
      .expect(200);
    expect(renewed.body.expiresIn).toBe(DAYS_30);
    expect(renewed.body.customerId).toBe(customerId);

    // Sin app, la renovación da 48 h.
    const renewedBrowser = await http()
      .post('/portal/me/session/renew')
      .set({ Authorization: `Bearer ${browser.body.accessToken}` })
      .send({})
      .expect(200);
    expect(renewedBrowser.body.expiresIn).toBe(HOURS_48);

    // «Cerrar sesiones del portal» corta también la de la app (y su renovación).
    await http()
      .post(`/customers/${customerId}/portal-link/revoke-sessions`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect((r) => expect([200, 201, 204]).toContain(r.status));
    await http()
      .post('/portal/me/session/renew')
      .set({ Authorization: `Bearer ${renewed.body.accessToken}` })
      .send({ installedApp: true })
      .expect(401);

    await http().post('/portal/me/session/renew').send({ installedApp: true }).expect(401);
  });
});
