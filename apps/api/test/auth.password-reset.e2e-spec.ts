import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, uniqueTestIds } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('POST /auth/password/forgot + /auth/password/reset (e2e)', () => {
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

  async function registerVerifiedUser(prefix: string) {
    const ids = uniqueTestIds(prefix);
    const reg = await request(app.getHttpServer()).post('/auth/register').send({
      tenantName: 'PWReset Test',
      tenantSlug: ids.slug,
      fullName: 'PWReset User',
      email: ids.email,
      password: 'Secret123',
      acceptTerms: true,
    });
    expect(reg.status).toBe(201);
    const verifMail = await waitForEmail(ids.email, { subjectIncludes: 'Verifica' });
    const verifToken = extractToken(verifMail.Text, '/verify-email');
    const verif = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: verifToken });
    expect(verif.status).toBe(200);
    await deleteAllMessages();
    return {
      slug: ids.slug,
      email: ids.email,
      userId: reg.body.user.id as string,
      tenantId: reg.body.tenant.id as string,
    };
  }

  it('forgot envia email, reset cambia password y revoca todas las sesiones', async () => {
    const ctx = await registerVerifiedUser('pw-flow');

    // Creamos sesiones extra haciendo logins.
    for (let i = 0; i < 2; i++) {
      const res = await request(app.getHttpServer()).post('/auth/login').send({
        tenantSlug: ctx.slug,
        email: ctx.email,
        password: 'Secret123',
      });
      expect(res.status).toBe(200);
    }
    const activeBefore = await admin.session.count({
      where: { userId: ctx.userId, revokedAt: null },
    });
    expect(activeBefore).toBeGreaterThan(0);

    // Forgot
    const forgot = await request(app.getHttpServer())
      .post('/auth/password/forgot')
      .send({ tenantSlug: ctx.slug, email: ctx.email });
    expect(forgot.status).toBe(204);
    const mail = await waitForEmail(ctx.email, { subjectIncludes: 'Restablece' });
    const token = extractToken(mail.Text, '/reset-password');

    // Reset
    const reset = await request(app.getHttpServer())
      .post('/auth/password/reset')
      .send({ token, password: 'NewSecret456' });
    expect(reset.status).toBe(204);

    // Todas las sesiones del user quedan revocadas.
    const activeAfter = await admin.session.count({
      where: { userId: ctx.userId, revokedAt: null },
    });
    expect(activeAfter).toBe(0);

    // La password antigua ya no funciona.
    const oldLogin = await request(app.getHttpServer()).post('/auth/login').send({
      tenantSlug: ctx.slug,
      email: ctx.email,
      password: 'Secret123',
    });
    expect(oldLogin.status).toBe(401);

    // La nueva si.
    const newLogin = await request(app.getHttpServer()).post('/auth/login').send({
      tenantSlug: ctx.slug,
      email: ctx.email,
      password: 'NewSecret456',
    });
    expect(newLogin.status).toBe(200);
  });

  it('reusar el token de reset devuelve 401', async () => {
    const ctx = await registerVerifiedUser('pw-reuse');
    await request(app.getHttpServer())
      .post('/auth/password/forgot')
      .send({ tenantSlug: ctx.slug, email: ctx.email });
    const mail = await waitForEmail(ctx.email, { subjectIncludes: 'Restablece' });
    const token = extractToken(mail.Text, '/reset-password');

    const ok = await request(app.getHttpServer())
      .post('/auth/password/reset')
      .send({ token, password: 'OneTime123' });
    expect(ok.status).toBe(204);

    const replay = await request(app.getHttpServer())
      .post('/auth/password/reset')
      .send({ token, password: 'TwoTime123' });
    expect(replay.status).toBe(401);
  });

  it('forgot con email desconocido devuelve 204 sin enviar email', async () => {
    await deleteAllMessages();
    const res = await request(app.getHttpServer())
      .post('/auth/password/forgot')
      .send({ tenantSlug: 'test-nope', email: 'nobody@example.com' });
    expect(res.status).toBe(204);
    // Damos un breve margen para asegurar que no llega ningun email.
    await new Promise((r) => setTimeout(r, 500));
    // El helper consulta Mailpit; si no hay mensaje, devuelve []
    const url = `${process.env.MAILPIT_API_URL ?? 'http://localhost:8026/api/v1'}/search?query=${encodeURIComponent('to:nobody@example.com')}`;
    const lookup = await fetch(url);
    const data = (await lookup.json()) as { messages: unknown[] };
    expect(data.messages).toHaveLength(0);
  });
});
