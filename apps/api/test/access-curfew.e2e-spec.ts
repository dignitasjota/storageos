import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Ventana de toque de queda de 61 min que cubre "ahora" en Europe/Madrid. */
function curfewWindowCoveringNow(): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')!.value);
  const nowMin = hh * 60 + mm;
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { start: fmt((nowMin - 1 + 1440) % 1440), end: fmt((nowMin + 60) % 1440) };
}

describe('Toque de queda de acceso (curfew) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('bloquea durante el toque de queda salvo credenciales con acceso 24h', async () => {
    const owner = await registerVerifiedUser(app, 'curfew');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local Curfew', country: 'ES' });
    expect(facility.status).toBe(201);

    // Toque de queda cubriendo el momento actual.
    const { start, end } = curfewWindowCoveringNow();
    await request(app.getHttpServer())
      .patch(`/facilities/${facility.body.id}`)
      .set(auth)
      .send({ accessCurfewEnabled: true, accessCurfewStart: start, accessCurfewEnd: end })
      .expect(200);

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Lopez', country: 'ES' });
    const device = await request(app.getHttpServer())
      .post('/access/devices')
      .set(auth)
      .send({
        facilityId: facility.body.id,
        type: 'gate',
        name: 'Cancela',
        hardwareId: 'curfew-dev-1',
      });
    const apiKey = device.body.revealedApiKey as string;

    // Credencial normal → denegada por el toque de queda.
    const normal = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId: customer.body.id, method: 'pin' });
    const denied = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: normal.body.revealedSecret, deviceId: 'curfew-dev-1' });
    expect(denied.status).toBe(200);
    expect(denied.body.allowed).toBe(false);
    expect(denied.body.result).toBe('denied_outside_hours');

    // Credencial con acceso 24h (staff) → permitida durante el toque de queda.
    const staff = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId: customer.body.id, method: 'pin', bypassCurfew: true });
    expect(staff.body.bypassCurfew).toBe(true);
    const allowed = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: staff.body.revealedSecret, deviceId: 'curfew-dev-1' });
    expect(allowed.body.allowed).toBe(true);
    expect(allowed.body.result).toBe('allowed');

    // Desactivado el toque de queda, la credencial normal vuelve a entrar.
    await request(app.getHttpServer())
      .patch(`/facilities/${facility.body.id}`)
      .set(auth)
      .send({ accessCurfewEnabled: false })
      .expect(200);
    const okNow = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: normal.body.revealedSecret, deviceId: 'curfew-dev-1' });
    expect(okNow.body.allowed).toBe(true);
  });
});
