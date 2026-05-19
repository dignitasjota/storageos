import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('POST /auth/verify-email + /auth/resend-verification (e2e)', () => {
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

  async function registerAndCaptureToken(prefix: string) {
    const ids = uniqueTestIds(prefix);
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'Verify Test',
      tenantSlug: ids.slug,
      fullName: 'Verify User',
      email: ids.email,
      password: 'Secret123',
      acceptTerms: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.requiresEmailVerification).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();

    const email = await waitForEmail(ids.email, { subjectIncludes: 'Verifica' });
    const token = extractToken(email.Text, '/verify-email');
    return { slug: ids.slug, email: ids.email, userId: res.body.user.id as string, token };
  }

  it('register no emite tokens y manda email; verify activa la cuenta y emite sesion', async () => {
    const ctx = await registerAndCaptureToken('verify');

    // Antes de verificar, login devuelve 403 con code email_not_verified.
    const blocked = await request(app.getHttpServer()).post('/auth/login').send({
      tenantSlug: ctx.slug,
      email: ctx.email,
      password: 'Secret123',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('email_not_verified');

    // Verificar.
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: ctx.token });
    expect(verified.status).toBe(200);
    expect(verified.body.user.id).toBe(ctx.userId);
    expect(typeof verified.body.accessToken).toBe('string');
    const setCookie = verified.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);

    // En BD: emailVerifiedAt no nulo, token usado.
    const user = await admin.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    expect(user.emailVerifiedAt).not.toBeNull();
    const tokensRow = await admin.emailVerificationToken.findMany({
      where: { userId: ctx.userId },
    });
    expect(tokensRow.every((t) => t.usedAt !== null)).toBe(true);

    // Login posterior: 200.
    const login = await request(app.getHttpServer()).post('/auth/login').send({
      tenantSlug: ctx.slug,
      email: ctx.email,
      password: 'Secret123',
    });
    expect(login.status).toBe(200);
  });

  it('reusar el token de verificacion devuelve 401', async () => {
    const ctx = await registerAndCaptureToken('verify-reuse');
    const ok = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: ctx.token });
    expect(ok.status).toBe(200);
    const replay = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: ctx.token });
    expect(replay.status).toBe(401);
  });

  it('resend-verification envia un nuevo email y invalida el anterior', async () => {
    const ctx = await registerAndCaptureToken('verify-resend');

    await deleteAllMessages();
    const resend = await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ tenantSlug: ctx.slug, email: ctx.email });
    expect(resend.status).toBe(204);

    const email = await waitForEmail(ctx.email, { subjectIncludes: 'Verifica' });
    const newToken = extractToken(email.Text, '/verify-email');
    expect(newToken).not.toBe(ctx.token);

    // El token original ya no funciona.
    const original = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: ctx.token });
    expect(original.status).toBe(401);

    // El nuevo si.
    const fresh = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: newToken });
    expect(fresh.status).toBe(200);
  });

  it('resend-verification con email desconocido devuelve 204 igualmente', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .send({ tenantSlug: 'test-nonexistent', email: 'nobody@example.com' });
    expect(res.status).toBe(204);
  });
});
