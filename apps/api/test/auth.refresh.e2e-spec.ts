import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { REFRESH_REUSE_GRACE_MS } from '../src/modules/auth/sessions.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
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

  async function registerNewTenant() {
    const user = await registerVerifiedUser(app, 'ref');
    return {
      slug: user.slug,
      userId: user.userId,
      tenantId: user.tenantId,
      accessToken: user.accessToken,
      cookie: user.refreshCookie,
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

  it('reusar un refresh rotado FUERA del margen de gracia revoca todas las sesiones (paranoid)', async () => {
    const { cookie, tenantId, userId } = await registerNewTenant();
    const ok = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
    expect(ok.status).toBe(200);
    // Simula que la rotación ocurrió hace más de REFRESH_REUSE_GRACE_MS.
    await admin.session.updateMany({
      where: { tenantId, userId, revokedReason: 'rotated' },
      data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 10_000) },
    });
    const replay = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);

    const sessions = await admin.session.findMany({ where: { tenantId, userId } });
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.revokedAt).not.toBeNull();
    }
    expect(sessions.map((s) => s.revokedReason)).toContain('refresh_reuse');
  });

  it('reusar un refresh recién rotado desde el mismo navegador (recarga que aborta el refresh) NO expulsa al usuario', async () => {
    const { cookie, tenantId, userId } = await registerNewTenant();
    // 1ª rotación: su respuesta "se pierde" (el navegador no guardó la cookie nueva).
    const lost = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
    expect(lost.status).toBe(200);
    // La página siguiente reenvía el token ya rotado, segundos después.
    const retry = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
    expect(retry.status).toBe(200);
    expect(retry.body.accessToken).toBeTruthy();

    const sessions = await admin.session.findMany({ where: { tenantId, userId } });
    expect(sessions.map((s) => s.revokedReason)).not.toContain('refresh_reuse');
    const original = sessions.find((s) => s.rotatedFromId === null)!;
    const active = sessions.filter((s) => s.revokedAt === null);
    expect(active).toHaveLength(2);
    for (const s of active) expect(s.rotatedFromId).toBe(original.id);
  });

  it('N refresh CONCURRENTES con el MISMO cookie (varias pestañas): no se revoca nada y el usuario sigue dentro', async () => {
    const { cookie, tenantId, userId } = await registerNewTenant();
    const attempts = 5;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie),
      ),
    );
    const succeeded = responses.filter((r) => r.status === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    for (const r of responses) expect([200, 401]).toContain(r.status);

    const sessions = await admin.session.findMany({ where: { tenantId, userId } });
    // Antes del margen de gracia, los perdedores disparaban el revoke-all y
    // el usuario podía quedarse con 0 sesiones activas.
    expect(sessions.map((s) => s.revokedReason)).not.toContain('refresh_reuse');
    const original = sessions.find((s) => s.rotatedFromId === null)!;
    expect(original.revokedReason).toBe('rotated');
    const active = sessions.filter((s) => s.revokedAt === null);
    expect(active).toHaveLength(succeeded.length);
    for (const s of active) expect(s.rotatedFromId).toBe(original.id);
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
