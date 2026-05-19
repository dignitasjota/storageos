import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('POST /auth/logout y /auth/logout-all (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function registerAndLogin(prefix: string) {
    const user = await registerVerifiedUser(app, prefix);
    return {
      accessToken: user.accessToken,
      cookie: user.refreshCookie,
      slug: user.slug,
      email: user.email,
      password: user.password,
      userId: user.userId,
      tenantId: user.tenantId,
    };
  }

  it('logout devuelve 204, revoca solo esa sesion y borra la cookie', async () => {
    const ctx = await registerAndLogin('logout');
    // crear una segunda sesion (login con misma credencial)
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: ctx.slug, email: ctx.email, password: ctx.password });
    expect(loginRes.status).toBe(200);

    const res = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${ctx.accessToken}`)
      .set('Cookie', ctx.cookie);
    expect(res.status).toBe(204);
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    // Header presente con expiracion en el pasado (clearCookie).
    expect(
      cookies.some((c) => c.startsWith('refresh_token=') && /Expires=Thu, 01 Jan 1970/.test(c)),
    ).toBe(true);

    const sessions = await admin.session.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.revokedAt).not.toBeNull();
    expect(sessions[0]?.revokedReason).toBe('logout');
    expect(sessions[1]?.revokedAt).toBeNull();
  });

  it('logout sin access token responde 401', async () => {
    const res = await request(app.getHttpServer()).post('/auth/logout');
    expect(res.status).toBe(401);
  });

  it('logout-all revoca todas las sesiones del user', async () => {
    const ctx = await registerAndLogin('logoutall');
    // Tres logins extra (4 sesiones en total).
    for (let i = 0; i < 3; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantSlug: ctx.slug, email: ctx.email, password: ctx.password });
      expect(res.status).toBe(200);
    }

    const res = await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${ctx.accessToken}`);
    expect(res.status).toBe(204);

    const active = await admin.session.count({
      where: { userId: ctx.userId, revokedAt: null },
    });
    expect(active).toBe(0);

    const revokedAll = await admin.session.findMany({ where: { userId: ctx.userId } });
    expect(revokedAll.every((s) => s.revokedReason === 'logout_all')).toBe(true);
  });
});
