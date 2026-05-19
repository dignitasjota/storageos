import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';
import { generateTotpCode } from './helpers/totp';

import type { INestApplication } from '@nestjs/common';

describe('2FA TOTP (e2e)', () => {
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

  /** Activa 2FA para un user recien creado y devuelve secret + recoveryCodes. */
  async function enable2fa(accessToken: string): Promise<{
    secret: string;
    recoveryCodes: string[];
  }> {
    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(setup.status).toBe(201);
    const secret = setup.body.secretBase32 as string;

    const verify = await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: generateTotpCode(secret) });
    expect(verify.status).toBe(200);
    return { secret, recoveryCodes: verify.body.recoveryCodes as string[] };
  }

  it('GET /auth/2fa/status sin 2FA -> enabled false', async () => {
    const user = await registerVerifiedUser(app, '2fa-status');
    const res = await request(app.getHttpServer())
      .get('/auth/2fa/status')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.recoveryCodesRemaining).toBe(0);
  });

  it('setup + verify activa 2FA y devuelve 10 recovery codes', async () => {
    const user = await registerVerifiedUser(app, '2fa-enable');
    const { recoveryCodes } = await enable2fa(user.accessToken);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c))).toBe(true);

    const status = await request(app.getHttpServer())
      .get('/auth/2fa/status')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(status.body.enabled).toBe(true);
    expect(status.body.recoveryCodesRemaining).toBe(10);
  });

  it('verify con codigo invalido -> 403 invalid_code', async () => {
    const user = await registerVerifiedUser(app, '2fa-bad-code');
    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(setup.status).toBe(201);

    const verify = await request(app.getHttpServer())
      .post('/auth/2fa/verify')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ code: '000000' });
    expect(verify.status).toBe(403);
    expect(verify.body.code).toBe('invalid_code');
  });

  it('login con 2FA -> requires2fa + pendingToken; challenge correcto emite sesion', async () => {
    const user = await registerVerifiedUser(app, '2fa-login');
    const { secret } = await enable2fa(user.accessToken);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.requires2fa).toBe(true);
    expect(typeof login.body.pendingToken).toBe('string');
    expect(login.body.accessToken).toBeUndefined();
    // No emite cookie de refresh todavia.
    const setCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((c) => c?.startsWith('refresh_token='))).toBe(false);

    const challenge = await request(app.getHttpServer())
      .post('/auth/2fa/challenge')
      .send({ pendingToken: login.body.pendingToken, code: generateTotpCode(secret) });
    expect(challenge.status).toBe(200);
    expect(typeof challenge.body.accessToken).toBe('string');
    const challengeCookies = Array.isArray(challenge.headers['set-cookie'])
      ? challenge.headers['set-cookie']
      : [challenge.headers['set-cookie']];
    expect(challengeCookies.some((c) => c?.startsWith('refresh_token='))).toBe(true);
  });

  it('challenge con codigo erroneo -> 403', async () => {
    const user = await registerVerifiedUser(app, '2fa-bad-challenge');
    await enable2fa(user.accessToken);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);

    const challenge = await request(app.getHttpServer())
      .post('/auth/2fa/challenge')
      .send({ pendingToken: login.body.pendingToken, code: '000000' });
    expect(challenge.status).toBe(403);
    expect(challenge.body.code).toBe('invalid_code');
  });

  it('recovery code: consumible una sola vez', async () => {
    const user = await registerVerifiedUser(app, '2fa-recovery');
    const { recoveryCodes } = await enable2fa(user.accessToken);
    const code = recoveryCodes[0]!;

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    const challenge1 = await request(app.getHttpServer())
      .post('/auth/2fa/challenge')
      .send({ pendingToken: login.body.pendingToken, recoveryCode: code });
    expect(challenge1.status).toBe(200);

    // Replay del mismo codigo -> 403.
    const login2 = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    const challenge2 = await request(app.getHttpServer())
      .post('/auth/2fa/challenge')
      .send({ pendingToken: login2.body.pendingToken, recoveryCode: code });
    expect(challenge2.status).toBe(403);
  });

  it('regenerate invalida los recovery codes anteriores', async () => {
    const user = await registerVerifiedUser(app, '2fa-regen');
    const { secret, recoveryCodes } = await enable2fa(user.accessToken);
    const oldCode = recoveryCodes[0]!;

    const regen = await request(app.getHttpServer())
      .post('/auth/2fa/recovery-codes/regenerate')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ currentPassword: user.password, code: generateTotpCode(secret) });
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCodes).toHaveLength(10);
    expect(regen.body.recoveryCodes).not.toContain(oldCode);

    // El codigo viejo ya no sirve.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    const challenge = await request(app.getHttpServer())
      .post('/auth/2fa/challenge')
      .send({ pendingToken: login.body.pendingToken, recoveryCode: oldCode });
    expect(challenge.status).toBe(403);
  });

  it('disable con password incorrecta -> 403', async () => {
    const user = await registerVerifiedUser(app, '2fa-bad-disable');
    const { secret } = await enable2fa(user.accessToken);

    const res = await request(app.getHttpServer())
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ currentPassword: 'WrongPass1', code: generateTotpCode(secret) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('wrong_current_password');
  });

  it('disable con TOTP correcto -> login vuelve a ser directo', async () => {
    const user = await registerVerifiedUser(app, '2fa-disable');
    const { secret } = await enable2fa(user.accessToken);

    const disable = await request(app.getHttpServer())
      .post('/auth/2fa/disable')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ currentPassword: user.password, code: generateTotpCode(secret) });
    expect(disable.status).toBe(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.requires2fa).toBeUndefined();
    expect(typeof login.body.accessToken).toBe('string');
  });
});
