import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('POST /auth/refresh (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  async function registerNewTenant() {
    const ids = uniqueTestIds('ref');
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Test Refresh',
      tenantSlug: ids.slug,
      fullName: 'Test',
      email: ids.email,
      password: 'Secret123',
      acceptTerms: true,
    });
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const cookie = cookies.find((c) => c.startsWith('refresh_token='));
    if (!cookie) throw new Error('no refresh cookie');
    return {
      slug: ids.slug,
      userId: res.body.user.id as string,
      tenantId: res.body.tenant.id as string,
      accessToken: res.body.accessToken as string,
      cookie,
    };
  }

  it('rota el refresh y devuelve un access nuevo + cookie nueva', async () => {
    const { cookie, tenantId, userId } = await registerNewTenant();
    const res = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const newCookie = cookies.find((c) => c.startsWith('refresh_token='));
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toBe(cookie);

    const sessions = await admin.session.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.revokedAt).not.toBeNull();
    expect(sessions[0]?.revokedReason).toBe('rotated');
    expect(sessions[1]?.rotatedFromId).toBe(sessions[0]?.id);
    expect(sessions[1]?.revokedAt).toBeNull();
  });

  it('reusar un refresh ya rotado revoca todas las sesiones del usuario (paranoid)', async () => {
    const { cookie, tenantId, userId } = await registerNewTenant();
    // primer refresh exitoso
    const ok = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
    expect(ok.status).toBe(200);
    // reuso del refresh original (ya revocado por rotacion)
    const replay = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);

    const sessions = await admin.session.findMany({ where: { tenantId, userId } });
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.revokedAt).not.toBeNull();
    }
    const reasons = sessions.map((s) => s.revokedReason);
    expect(reasons).toContain('refresh_reuse');
  });

  it('responde 401 cuando no hay cookie', async () => {
    const res = await request(app.getHttpServer()).post('/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Refresh requerido');
  });

  it('responde 401 ante un refresh con formato invalido', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', 'refresh_token=garbage-value');
    expect(res.status).toBe(401);
  });

  it('responde 401 ante un refresh con tenant manipulado', async () => {
    const { cookie } = await registerNewTenant();
    const original = cookie.split(';')[0]?.replace('refresh_token=', '') ?? '';
    const parts = original.split('.');
    expect(parts).toHaveLength(3);
    const tampered = `tampered-uuid.${parts[1]}.${parts[2]}`;
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', `refresh_token=${tampered}`);
    expect(res.status).toBe(401);
  });
});
