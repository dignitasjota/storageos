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

  it('condición de carrera: N refresh CONCURRENTES con el MISMO cookie — solo UNO rota con éxito, sin sesiones huérfanas', async () => {
    const { cookie, tenantId, userId } = await registerNewTenant();

    // 5 requests en paralelo con el mismo refresh token todavía válido (aún
    // no rotado por ninguno). Antes del fix, el `update` sin condición de
    // `rotate()` dejaba que TODOS pasaran la lectura+verificación y cada uno
    // generase su propia sesión nueva a partir de un solo uso del token —
    // sin disparar nunca la detección de reuso. El compare-and-swap
    // (`updateMany` con `WHERE revokedAt IS NULL`) debe dejar pasar
    // exactamente una.
    const attempts = 5;
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie),
      ),
    );

    const succeeded = responses.filter((r) => r.status === 200);
    const failed = responses.filter((r) => r.status === 401);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(attempts - 1);

    // Solo el ganador de la carrera llega a crear una sesión nueva (los
    // perdedores nunca llaman `create`): sesión original + exactamente 1.
    // Si el fix no estuviera, aquí veríamos varias sesiones nuevas
    // (una por cada request que "ganaba" su propia lectura+escritura).
    const sessions = await admin.session.findMany({ where: { tenantId, userId } });
    expect(sessions).toHaveLength(2);

    // Nunca puede haber MÁS de una sesión activa a la vez a partir de un
    // solo uso del token (la garantía que cierra la carrera). Puede haber 0
    // si algún perdedor, al detectar el reuso, dispara el revoke-all
    // paranoid DESPUÉS de que el ganador ya hubiera creado la suya (el
    // revoke-all barre TODAS las sesiones activas del usuario, sin
    // distinguir cuál es "la buena") — es una consecuencia esperada de la
    // política paranoid, no un fallo del fix.
    const active = sessions.filter((s) => s.revokedAt === null);
    expect(active.length).toBeLessThanOrEqual(1);

    // La sesión ORIGINAL (la que todos leyeron) siempre queda marcada
    // 'rotated' por el ganador, sin importar qué pase después con la nueva.
    const original = sessions.find((s) => s.rotatedFromId === null);
    expect(original?.revokedReason).toBe('rotated');
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
