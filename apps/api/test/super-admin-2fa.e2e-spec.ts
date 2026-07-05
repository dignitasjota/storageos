import request from 'supertest';

import {
  cleanupSuperAdmins,
  extractSuperAdminRefreshCookie,
  seedSuperAdmin,
  type SeededSuperAdmin,
} from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';
import { generateTotpCode } from './helpers/totp';

import type { INestApplication } from '@nestjs/common';

/**
 * Tests e2e de la Fase 9A: super admin con 2FA TOTP + refresh cookie httpOnly
 * con rotacion paranoid.
 */
describe('Fase 9A: super admin 2FA + refresh cookie (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  // ------------------------------------------------------------------------
  // Helpers comunes
  // ------------------------------------------------------------------------

  async function loginNoTwoFactor(admin: SeededSuperAdmin): Promise<{
    accessToken: string;
    refreshCookie: string;
  }> {
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
    const cookie = extractSuperAdminRefreshCookie(login.headers);
    if (!cookie) throw new Error('login no devolvio cookie super_admin_refresh');
    return { accessToken: login.body.accessToken as string, refreshCookie: cookie };
  }

  async function enableTwoFactor(accessToken: string): Promise<{
    secret: string;
    recoveryCodes: string[];
  }> {
    const setup = await request(app.getHttpServer())
      .post('/admin/auth/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(setup.status).toBe(200);
    expect(typeof setup.body.otpauthUri).toBe('string');
    expect(typeof setup.body.secretBase32).toBe('string');
    expect(typeof setup.body.qrCode).toBe('string');
    expect((setup.body.qrCode as string).startsWith('data:image/png;base64,')).toBe(true);
    const secret = setup.body.secretBase32 as string;

    const verify = await request(app.getHttpServer())
      .post('/admin/auth/2fa/verify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: generateTotpCode(secret) });
    expect(verify.status).toBe(200);
    const recoveryCodes = verify.body.recoveryCodes as string[];
    expect(Array.isArray(recoveryCodes)).toBe(true);
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
    return { secret, recoveryCodes };
  }

  // ------------------------------------------------------------------------
  // 1) Login sin 2FA
  // ------------------------------------------------------------------------

  describe('login sin 2FA', () => {
    it('credenciales correctas -> 200 + cookie httpOnly + sameSite=strict + path=/v1/admin', async () => {
      const admin = await seedSuperAdmin('login-ok');
      const login = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });

      expect(login.status).toBe(200);
      expect(login.body.accessToken).toBeTruthy();
      expect(typeof login.body.expiresIn).toBe('number');
      expect(login.body.admin?.email).toBe(admin.email);
      expect(login.body.requires2fa).toBeUndefined();

      const rawCookies = login.headers['set-cookie'];
      const cookies: string[] = Array.isArray(rawCookies)
        ? (rawCookies as string[])
        : rawCookies
          ? [rawCookies as string]
          : [];
      const refreshCookie = cookies.find((c) => c.startsWith('super_admin_refresh='));
      expect(refreshCookie).toBeDefined();
      // Atributos de seguridad obligatorios.
      expect(refreshCookie).toMatch(/HttpOnly/i);
      expect(refreshCookie).toMatch(/SameSite=Strict/i);
      // Path acotado a /v1/admin: el API sirve bajo el prefijo de versión, así
      // que la cookie debe scopearse ahí para que llegue a /v1/admin/auth/refresh.
      expect(refreshCookie).toMatch(/Path=\/v1\/admin/);
    });

    it('password incorrecto -> 401', async () => {
      const admin = await seedSuperAdmin('login-bad-pwd');
      const res = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: 'WrongPassword!99' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });

    it('email inexistente -> 401 con el mismo codigo (sin enumeracion)', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: 'no-existe-jamas@storageos.local', password: 'WhatEver!99' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });
  });

  // ------------------------------------------------------------------------
  // 2) Setup + verify + login con 2FA + challenge
  // ------------------------------------------------------------------------

  describe('setup + verify + login con 2FA', () => {
    it('flujo completo: setup -> verify -> status -> login requiere 2FA -> challenge OK', async () => {
      const admin = await seedSuperAdmin('2fa-full');
      const session = await loginNoTwoFactor(admin);
      const { secret } = await enableTwoFactor(session.accessToken);

      const status = await request(app.getHttpServer())
        .get('/admin/auth/2fa/status')
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(status.status).toBe(200);
      expect(status.body.enabled).toBe(true);
      expect(status.body.recoveryCodesRemaining).toBe(10);
      expect(typeof status.body.enrolledAt).toBe('string');

      // Logout para invalidar la sesion previa (limpia cookie en el cliente).
      await request(app.getHttpServer())
        .post('/admin/auth/logout')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .set('Cookie', session.refreshCookie);

      // Segundo login: debe devolver pendingToken y NO cookie ni accessToken.
      const login2 = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      expect(login2.status).toBe(200);
      expect(login2.body.requires2fa).toBe(true);
      expect(typeof login2.body.pendingToken).toBe('string');
      expect(login2.body.accessToken).toBeUndefined();
      expect(extractSuperAdminRefreshCookie(login2.headers)).toBeNull();

      // Challenge con codigo TOTP correcto -> sesion real.
      const challenge = await request(app.getHttpServer())
        .post('/admin/auth/2fa/challenge')
        .send({ pendingToken: login2.body.pendingToken, code: generateTotpCode(secret) });
      expect(challenge.status).toBe(200);
      expect(typeof challenge.body.accessToken).toBe('string');
      expect(challenge.body.admin?.email).toBe(admin.email);
      expect(extractSuperAdminRefreshCookie(challenge.headers)).toBeTruthy();
    });

    it('challenge con codigo TOTP invalido -> 403, pendingToken sigue siendo reutilizable', async () => {
      const admin = await seedSuperAdmin('2fa-bad-code');
      const session = await loginNoTwoFactor(admin);
      const { secret } = await enableTwoFactor(session.accessToken);

      const login = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      expect(login.body.requires2fa).toBe(true);
      const pendingToken = login.body.pendingToken as string;

      const bad = await request(app.getHttpServer())
        .post('/admin/auth/2fa/challenge')
        .send({ pendingToken, code: '000000' });
      expect(bad.status).toBe(403);
      expect(bad.body.code).toBe('invalid_code');

      // El pendingToken NO se ha consumido: un segundo intento con el codigo
      // correcto debe funcionar.
      const ok = await request(app.getHttpServer())
        .post('/admin/auth/2fa/challenge')
        .send({ pendingToken, code: generateTotpCode(secret) });
      expect(ok.status).toBe(200);
      expect(typeof ok.body.accessToken).toBe('string');
    });
  });

  // ------------------------------------------------------------------------
  // 3) Recovery code single-use
  // ------------------------------------------------------------------------

  describe('recovery code single-use', () => {
    it('un recovery code funciona una vez y luego es rechazado', async () => {
      const admin = await seedSuperAdmin('2fa-recovery');
      const session = await loginNoTwoFactor(admin);
      const { recoveryCodes } = await enableTwoFactor(session.accessToken);
      const code = recoveryCodes[0]!;

      // Login + challenge usando recovery code.
      const login1 = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      expect(login1.body.requires2fa).toBe(true);
      const challenge1 = await request(app.getHttpServer())
        .post('/admin/auth/2fa/challenge')
        .send({ pendingToken: login1.body.pendingToken, code });
      expect(challenge1.status).toBe(200);
      const newAccess = challenge1.body.accessToken as string;

      // Reintentar mismo recovery -> 403.
      const login2 = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      const challenge2 = await request(app.getHttpServer())
        .post('/admin/auth/2fa/challenge')
        .send({ pendingToken: login2.body.pendingToken, code });
      expect(challenge2.status).toBe(403);
      expect(challenge2.body.code).toBe('invalid_code');

      // Status: ahora quedan 9 recovery codes.
      const status = await request(app.getHttpServer())
        .get('/admin/auth/2fa/status')
        .set('Authorization', `Bearer ${newAccess}`);
      expect(status.status).toBe(200);
      expect(status.body.recoveryCodesRemaining).toBe(9);
    });
  });

  // ------------------------------------------------------------------------
  // 4) Refresh cookie + paranoid reuse detection
  // ------------------------------------------------------------------------

  describe('refresh cookie + paranoid reuse', () => {
    it('rota la cookie en cada refresh; el reuso revoca todas las sesiones', async () => {
      const admin = await seedSuperAdmin('refresh-paranoid');
      const session1 = await loginNoTwoFactor(admin);
      const cookie1 = session1.refreshCookie;

      // Primer refresh: rota la cookie.
      const refresh1 = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .set('Cookie', cookie1);
      expect(refresh1.status).toBe(200);
      expect(typeof refresh1.body.accessToken).toBe('string');
      const cookie2 = extractSuperAdminRefreshCookie(refresh1.headers);
      expect(cookie2).toBeTruthy();
      expect(cookie2).not.toBe(cookie1);

      // Reuso de la cookie1 (ya rotada) -> 401 + revocacion total.
      const replay = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .set('Cookie', cookie1);
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('invalid_refresh');

      // La cookie2 tambien queda invalidada por la deteccion de reuso.
      const followup = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .set('Cookie', cookie2 as string);
      expect(followup.status).toBe(401);
      expect(followup.body.code).toBe('invalid_refresh');
    });
  });

  // ------------------------------------------------------------------------
  // 5) Disable 2FA
  // ------------------------------------------------------------------------

  describe('disable 2FA', () => {
    it('tras disable login vuelve a ser directo y las sesiones previas se revocan', async () => {
      const admin = await seedSuperAdmin('2fa-disable');
      const session = await loginNoTwoFactor(admin);
      await enableTwoFactor(session.accessToken);
      // session.accessToken sigue valido (es JWT), pero su refresh sigue activo.

      const disable = await request(app.getHttpServer())
        .post('/admin/auth/2fa/disable')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ password: admin.password });
      expect(disable.status).toBe(204);

      // Login subsiguiente: directo, sin pendingToken.
      const login = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      expect(login.status).toBe(200);
      expect(login.body.requires2fa).toBeUndefined();
      expect(typeof login.body.accessToken).toBe('string');

      // El refresh anterior a disable ya no funciona.
      const replay = await request(app.getHttpServer())
        .post('/admin/auth/refresh')
        .set('Cookie', session.refreshCookie);
      expect(replay.status).toBe(401);
    });

    it('disable con password incorrecto -> 403', async () => {
      const admin = await seedSuperAdmin('2fa-disable-bad');
      const session = await loginNoTwoFactor(admin);
      await enableTwoFactor(session.accessToken);

      const res = await request(app.getHttpServer())
        .post('/admin/auth/2fa/disable')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ password: 'WrongPassword!99' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('wrong_password');
    });
  });

  // ------------------------------------------------------------------------
  // 6) Regenerate recovery codes invalida los anteriores
  // ------------------------------------------------------------------------

  describe('regenerate recovery codes', () => {
    it('genera 10 nuevos codigos y los anteriores dejan de funcionar', async () => {
      const admin = await seedSuperAdmin('2fa-regen');
      const session = await loginNoTwoFactor(admin);
      const { recoveryCodes: original } = await enableTwoFactor(session.accessToken);
      const oldCode = original[0]!;

      const regen = await request(app.getHttpServer())
        .post('/admin/auth/2fa/recovery-codes/regenerate')
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(regen.status).toBe(200);
      const fresh = regen.body.recoveryCodes as string[];
      expect(fresh).toHaveLength(10);
      expect(fresh).not.toContain(oldCode);
      for (const code of fresh) {
        expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      }

      // El codigo viejo ya no sirve.
      const login = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      const challenge = await request(app.getHttpServer())
        .post('/admin/auth/2fa/challenge')
        .send({ pendingToken: login.body.pendingToken, code: oldCode });
      expect(challenge.status).toBe(403);

      // Un codigo nuevo si funciona.
      const login2 = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: admin.email, password: admin.password });
      const ok = await request(app.getHttpServer())
        .post('/admin/auth/2fa/challenge')
        .send({ pendingToken: login2.body.pendingToken, code: fresh[0]! });
      expect(ok.status).toBe(200);
    });
  });
});
