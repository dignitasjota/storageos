import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Staff genera magic link del portal (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('el staff genera el enlace y el inquilino accede con él (sin email)', async () => {
    const owner = await registerVerifiedUser(app, 'plink');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `plink-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Generar el enlace desde el panel.
    const gen = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    expect(gen.status).toBe(201);
    expect(gen.body.url).toContain('/portal/consume?token=');
    expect(gen.body.expiresAt).toBeTruthy();

    // Extraer el token del enlace y consumirlo (lo que haría el inquilino).
    const token = gen.body.url.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    expect(consume.status).toBe(200);
    expect(consume.body.customerId).toBe(customerId);
    expect(consume.body.accessToken).toBeTruthy();

    // Single-use: un segundo consumo falla.
    const replay = await request(app.getHttpServer()).post('/portal/login/consume').send({ token });
    expect(replay.status).toBe(401);

    // Queda auditado quién generó el enlace (sin el token/secreto).
    const audit = await db.auditLog.findFirst({
      where: { action: 'portal.magic_link_generated', entityId: customerId },
    });
    expect(audit).toBeTruthy();
    expect(audit?.entityType).toBe('Customer');
  });

  it('404 si el cliente no existe, 401 sin autenticación', async () => {
    const owner = await registerVerifiedUser(app, 'plinkx');
    const ghost = await request(app.getHttpServer())
      .post('/customers/00000000-0000-0000-0000-000000000000/portal-link')
      .set({ Authorization: `Bearer ${owner.accessToken}` });
    expect(ghost.status).toBe(404);

    const noauth = await request(app.getHttpServer()).post(
      '/customers/00000000-0000-0000-0000-000000000000/portal-link',
    );
    expect(noauth.status).toBe(401);
  });
});
