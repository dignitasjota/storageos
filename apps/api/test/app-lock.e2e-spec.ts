import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Bloqueo de la app del panel en el móvil: PIN de respaldo y llaves de acceso. */
describe('Bloqueo de la app (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('PIN: se guarda, desbloquea y a los 5 fallos cierra todas las sesiones', async () => {
    const user = await registerVerifiedUser(app, 'applockpin');
    const auth = { Authorization: `Bearer ${user.accessToken}` };

    const empty = await http().get('/me/app-lock').set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ pinSet: false, passkeys: [], idleMinutes: 15 });

    await http().put('/me/app-lock/pin').set(auth).send({ pin: '12' }).expect(400);
    await http().put('/me/app-lock/pin').set(auth).send({ pin: '4826' }).expect(204);
    expect((await http().get('/me/app-lock').set(auth)).body.pinSet).toBe(true);

    await http().post('/me/app-lock/unlock/pin').set(auth).send({ pin: '4826' }).expect(200);

    for (let i = 1; i <= 4; i++) {
      const wrong = await http().post('/me/app-lock/unlock/pin').set(auth).send({ pin: '0000' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('wrong_pin');
    }
    // Un acierto entre medias reinicia el contador.
    await http().post('/me/app-lock/unlock/pin').set(auth).send({ pin: '4826' }).expect(200);
    for (let i = 1; i <= 4; i++) {
      await http().post('/me/app-lock/unlock/pin').set(auth).send({ pin: '0000' }).expect(400);
    }
    const fifth = await http().post('/me/app-lock/unlock/pin').set(auth).send({ pin: '0000' });
    expect(fifth.status).toBe(401);
    expect(fifth.body.code).toBe('app_lock_exhausted');
    const live = await admin.session.count({ where: { userId: user.userId, revokedAt: null } });
    expect(live).toBe(0);

    await http().delete('/me/app-lock/pin').set(auth).expect(204);
    const noPin = await http().post('/me/app-lock/unlock/pin').set(auth).send({ pin: '4826' });
    expect(noPin.body.code).toBe('no_pin');
  });

  it('llaves de acceso: opciones de alta, respuesta inválida y sin llaves para desbloquear', async () => {
    const user = await registerVerifiedUser(app, 'applockkey');
    const auth = { Authorization: `Bearer ${user.accessToken}` };

    const options = await http().post('/me/app-lock/passkeys/options').set(auth);
    expect(options.status).toBe(200);
    expect(options.body.rp).toMatchObject({ id: 'localhost', name: 'TrasterOS' });
    expect(typeof options.body.challenge).toBe('string');
    expect(options.body.authenticatorSelection.userVerification).toBe('required');

    const bad = await http()
      .post('/me/app-lock/passkeys')
      .set(auth)
      .send({ response: { id: 'abc', rawId: 'abc', type: 'public-key', response: {} } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('passkey_invalid');

    // El reto es de un solo uso.
    const again = await http()
      .post('/me/app-lock/passkeys')
      .set(auth)
      .send({ response: { id: 'abc', rawId: 'abc', type: 'public-key', response: {} } });
    expect(again.body.code).toBe('passkey_challenge_expired');

    const unlock = await http().post('/me/app-lock/unlock/options').set(auth);
    expect(unlock.status).toBe(400);
    expect(unlock.body.code).toBe('no_passkeys');

    await http().get('/me/app-lock').expect(401);
  });
});
