import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Momento actual en Europe/Madrid: día de la semana (0-6) y minutos. */
function nowInMadrid(): { weekday: number; minutes: number } {
  const now = new Date();
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
  }).format(now);
  const wmap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')!.value);
  return { weekday: wmap[short]!, minutes: hh * 60 + mm };
}

const fmt = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

describe('Ventanas horarias por credencial (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('permite dentro de la franja de la credencial y deniega fuera', async () => {
    const owner = await registerVerifiedUser(app, 'windows');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local Ventanas', country: 'ES' });
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Emp', lastName: 'Leado', country: 'ES' });
    const device = await request(app.getHttpServer()).post('/access/devices').set(auth).send({
      facilityId: facility.body.id,
      type: 'gate',
      name: 'Puerta',
      hardwareId: 'win-dev-1',
    });
    const apiKey = device.body.revealedApiKey as string;

    const { weekday, minutes } = nowInMadrid();
    // Los tests corren a CUALQUIER hora → la franja debe contener "ahora"
    // (start inclusive, end exclusivo). En el borde de medianoche (minuto 0) el
    // start debe poder ser 00:00 → `Math.max(0, ...)` (antes era `max(1, ...)`,
    // que dejaba fuera el minuto 0 y hacía flakear el test a medianoche en CI).
    const lo = Math.max(0, minutes - 30);
    const hi = Math.min(1439, minutes + 30);

    // Credencial con una franja que CUBRE ahora (hoy).
    const inside = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({
        customerId: customer.body.id,
        method: 'pin',
        allowedHours: { windows: [{ days: [weekday], start: fmt(lo), end: fmt(hi) }] },
      });
    expect(inside.status).toBe(201);
    expect(inside.body.allowedHours.windows).toHaveLength(1);
    const okRes = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: inside.body.revealedSecret, deviceId: 'win-dev-1' });
    expect(okRes.body.allowed).toBe(true);
    expect(okRes.body.result).toBe('allowed');

    // Credencial con la franja en OTRO día (ayer) → fuera de horario hoy.
    const otherDay = (weekday + 6) % 7;
    const outside = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({
        customerId: customer.body.id,
        method: 'pin',
        allowedHours: { windows: [{ days: [otherDay], start: '00:00', end: '23:59' }] },
      });
    const denied = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: outside.body.revealedSecret, deviceId: 'win-dev-1' });
    expect(denied.body.allowed).toBe(false);
    expect(denied.body.result).toBe('denied_outside_hours');

    // Sin ventanas → acceso a cualquier hora.
    const free = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId: customer.body.id, method: 'pin', allowedHours: { windows: [] } });
    const freeRes = await request(app.getHttpServer())
      .post('/access/verify')
      .set('X-Device-Key', apiKey)
      .send({ method: 'pin', credential: free.body.revealedSecret, deviceId: 'win-dev-1' });
    expect(freeRes.body.allowed).toBe(true);

    // start >= end en una ventana → 400 (validación).
    await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({
        customerId: customer.body.id,
        method: 'pin',
        allowedHours: { windows: [{ days: [1], start: '20:00', end: '08:00' }] },
      })
      .expect(400);
  });
});
