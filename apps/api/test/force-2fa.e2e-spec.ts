import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';
import { generateTotpCode } from './helpers/totp';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Activa el flag `requireTwoFactorForManagers` para un tenant. Lo hacemos
 * por SQL directo (cliente admin) para evitar tener que crear un segundo
 * owner solo para mutar el flag desde el endpoint.
 */
async function setForce2faFlag(tenantId: string, value: boolean): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    await admin.tenant.update({
      where: { id: tenantId },
      data: { requireTwoFactorForManagers: value },
    });
  } finally {
    await admin.$disconnect();
  }
}

/** Cambia el rol de un user dentro del tenant. */
async function setUserRole(
  userId: string,
  role: 'owner' | 'manager' | 'staff' | 'readonly',
): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  try {
    await admin.user.update({ where: { id: userId }, data: { role } });
  } finally {
    await admin.$disconnect();
  }
}

/** Activa 2FA programaticamente; devuelve secret + recoveryCodes. */
async function enable2fa(
  app: INestApplication,
  accessToken: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
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

describe('Force 2FA enrolment (e2e)', () => {
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

  it('1. tenant flag=false: owner sin 2FA hace login -> access normal', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-off');
    // Flag por defecto es false.

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');
    expect(login.body.requires2fa).toBeUndefined();
    expect(login.body.requires2faEnrolment).toBeUndefined();
  });

  it('2. tenant flag=true: owner sin 2FA hace login -> enrolmentToken sin accessToken', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-owner');
    await setForce2faFlag(user.tenantId, true);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.requires2faEnrolment).toBe(true);
    expect(typeof login.body.enrolmentToken).toBe('string');
    expect(login.body.accessToken).toBeUndefined();
    expect(login.body.requires2fa).toBeUndefined();
    // No emite cookie de refresh todavia.
    const setCookie = login.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((c) => c?.startsWith('refresh_token='))).toBe(false);
  });

  it('3. setup con enrolmentToken invalido -> 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/2fa/enrol-required/setup')
      .send({ enrolmentToken: 'invalid.token.here.totallybroken' });
    expect(res.status).toBe(401);
  });

  it('4. verify con codigo TOTP correcto -> recoveryCodes + access + cookie refresh', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-verify');
    await setForce2faFlag(user.tenantId, true);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.body.requires2faEnrolment).toBe(true);
    const enrolmentToken = login.body.enrolmentToken as string;

    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/enrol-required/setup')
      .send({ enrolmentToken });
    expect(setup.status).toBe(200);
    const secret = setup.body.secretBase32 as string;
    expect(typeof secret).toBe('string');
    expect(typeof setup.body.otpauthUri).toBe('string');

    const verify = await request(app.getHttpServer())
      .post('/auth/2fa/enrol-required/verify')
      .send({ enrolmentToken, code: generateTotpCode(secret) });
    expect(verify.status).toBe(200);
    expect(typeof verify.body.accessToken).toBe('string');
    expect(Array.isArray(verify.body.recoveryCodes)).toBe(true);
    expect(verify.body.recoveryCodes).toHaveLength(10);

    const setCookie = verify.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.some((c) => c?.startsWith('refresh_token='))).toBe(true);

    // Tras el verify, el siguiente login del mismo user pasa por el flow
    // de challenge 2FA normal (no enrolment).
    const reLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(reLogin.status).toBe(200);
    expect(reLogin.body.requires2fa).toBe(true);
    expect(reLogin.body.requires2faEnrolment).toBeUndefined();
  });

  it('5. owner con 2FA ya activo y flag=true -> challenge normal', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-already');
    await enable2fa(app, user.accessToken);
    await setForce2faFlag(user.tenantId, true);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.requires2fa).toBe(true);
    expect(login.body.requires2faEnrolment).toBeUndefined();
    expect(typeof login.body.pendingToken).toBe('string');
  });

  it('6. manager con flag=true sin 2FA -> enrolment forzoso', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-mgr');
    // Bajamos rol owner -> manager (en produccion eso solo es posible
    // mediante transfer-ownership; aqui lo forzamos por SQL para aislar
    // el caso).
    await setUserRole(user.userId, 'manager');
    await setForce2faFlag(user.tenantId, true);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.requires2faEnrolment).toBe(true);
    expect(typeof login.body.enrolmentToken).toBe('string');
  });

  it('7. staff con flag=true sin 2FA -> access normal (staff no aplica)', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-staff');
    await setUserRole(user.userId, 'staff');
    await setForce2faFlag(user.tenantId, true);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');
    expect(login.body.requires2faEnrolment).toBeUndefined();
    expect(login.body.requires2fa).toBeUndefined();
  });

  it('8. PATCH /settings/tenant/security con rol manager -> 403', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-patch');
    await setUserRole(user.userId, 'manager');
    // Tras el cambio el access token sigue siendo el del owner, asi que
    // hacemos un login fresco para obtener un access con rol manager.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: user.slug, email: user.email, password: user.password });
    expect(login.status).toBe(200);
    const managerToken = login.body.accessToken as string;

    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/security')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ requireTwoFactorForManagers: true });
    expect(patch.status).toBe(403);
  });

  it('owner puede leer y mutar el flag via PATCH /settings/tenant/security', async () => {
    const user = await registerVerifiedUser(app, 'force2fa-owner-patch');

    const get1 = await request(app.getHttpServer())
      .get('/settings/tenant/security')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(get1.status).toBe(200);
    expect(get1.body.requireTwoFactorForManagers).toBe(false);

    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/security')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ requireTwoFactorForManagers: true });
    expect(patch.status).toBe(200);
    expect(patch.body.requireTwoFactorForManagers).toBe(true);

    const get2 = await request(app.getHttpServer())
      .get('/settings/tenant/security')
      .set('Authorization', `Bearer ${user.accessToken}`);
    expect(get2.body.requireTwoFactorForManagers).toBe(true);
  });
});
