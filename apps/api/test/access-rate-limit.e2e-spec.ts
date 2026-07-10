import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Anti-fuerza-bruta de `/access/verify`: además del throttle por IP, un
 * dispositivo se bloquea tras N (default 10) PINs no reconocidos.
 */
describe('Rate-limit de accesos: lockout por dispositivo (e2e)', () => {
  let app: INestApplication;
  const DEVICE_MAX = 10; // ACCESS_BRUTEFORCE_DEVICE_MAX por defecto

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: `Local ${suffix}`, country: 'ES' });
    const hardwareId = `${suffix}-dev`;
    const device = await request(app.getHttpServer())
      .post('/access/devices')
      .set(auth)
      .send({ facilityId: facility.body.id, type: 'gate', name: 'Cancela', hardwareId });
    const apiKey = device.body.revealedApiKey as string;
    const customerId = await createCustomer(app, owner.accessToken);
    await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin', pin: '135790', allowedHours: {} })
      .expect(201);
    return { apiKey, hardwareId };
  }

  const verify = (apiKey: string, hardwareId: string, pin: string) =>
    request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: pin, deviceId: hardwareId });

  it('bloquea el dispositivo tras N PINs erróneos; el PIN correcto ya no abre', async () => {
    const { apiKey, hardwareId } = await setup('rl-lock');

    // N intentos con PIN no reconocido → cada uno denied_invalid_credential.
    for (let i = 0; i < DEVICE_MAX; i++) {
      const bad = await verify(apiKey, hardwareId, String(100000 + i));
      expect(bad.body.allowed).toBe(false);
      expect(bad.body.result).toBe('denied_invalid_credential');
    }

    // Con el dispositivo ya bloqueado, incluso el PIN CORRECTO se deniega.
    const locked = await verify(apiKey, hardwareId, '135790');
    expect(locked.body.allowed).toBe(false);
    expect(locked.body.result).toBe('denied_unknown');
  });

  it('por debajo del umbral, el PIN correcto abre (y resetea el contador)', async () => {
    const { apiKey, hardwareId } = await setup('rl-ok');

    // Menos fallos que el umbral.
    for (let i = 0; i < DEVICE_MAX - 2; i++) {
      await verify(apiKey, hardwareId, String(200000 + i));
    }
    // El PIN correcto abre (no está bloqueado) y limpia los contadores.
    const ok = await verify(apiKey, hardwareId, '135790');
    expect(ok.body.allowed).toBe(true);
  });
});
