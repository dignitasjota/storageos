import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const SUPPORT_EMAIL = 'support-agility-test@storageos.local';

describe('Soporte más ágil (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let auth: { Authorization: string };
  const cannedIds: string[] = [];

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: SUPPORT_EMAIL } });
    // El rol soporte también gestiona las respuestas guardadas.
    await admin.superAdmin.create({
      data: {
        email: SUPPORT_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Soporte',
        role: 'support',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: SUPPORT_EMAIL, password: 'AdminTest!23' });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await admin.supportCannedResponse.deleteMany({ where: { id: { in: cannedIds } } });
    await admin.superAdmin.deleteMany({ where: { email: SUPPORT_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('respuestas guardadas: crear, editar, listar y borrar', async () => {
    const created = await request(app.getHttpServer())
      .post('/admin/support/canned-responses')
      .set(auth)
      .send({ title: 'Remesas SEPA e2e', body: 'Hola, {nombre}: en {empresa} …' });
    expect(created.status).toBe(201);
    cannedIds.push(created.body.id);
    expect(created.body.authorName).toBe('Soporte');

    await request(app.getHttpServer())
      .put(`/admin/support/canned-responses/${created.body.id}`)
      .set(auth)
      .send({ title: 'Remesas SEPA e2e', body: 'Texto nuevo' })
      .expect(200);
    const list = await request(app.getHttpServer())
      .get('/admin/support/canned-responses')
      .set(auth);
    expect(
      (list.body as { id: string; body: string }[]).find((r) => r.id === created.body.id)?.body,
    ).toBe('Texto nuevo');

    await request(app.getHttpServer())
      .delete(`/admin/support/canned-responses/${created.body.id}`)
      .set(auth)
      .expect(204);
    await request(app.getHttpServer())
      .delete(`/admin/support/canned-responses/${created.body.id}`)
      .set(auth)
      .expect(404);
  });

  it('la primera respuesta (no las notas internas) fija el tiempo de respuesta', async () => {
    const owner = await registerVerifiedUser(app, 'supportagility');
    const before = (await request(app.getHttpServer()).get('/admin/support/stats').set(auth))
      .body as { awaitingFirstResponse: number; ticketsAnswered: number };

    const ticket = await request(app.getHttpServer())
      .post('/support/tickets')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ subject: 'No me salen las remesas', body: 'Ayuda', priority: 'normal' });
    expect(ticket.status).toBe(201);
    const id = ticket.body.id as string;

    const mid = (await request(app.getHttpServer()).get('/admin/support/stats').set(auth)).body as {
      awaitingFirstResponse: number;
    };
    expect(mid.awaitingFirstResponse).toBe(before.awaitingFirstResponse + 1);

    await request(app.getHttpServer())
      .post(`/admin/support/tickets/${id}/messages`)
      .set(auth)
      .send({ body: 'Nota interna', isInternal: true });
    let detail = await request(app.getHttpServer()).get(`/admin/support/tickets/${id}`).set(auth);
    expect(detail.body.firstResponseAt).toBeNull();

    await request(app.getHttpServer())
      .post(`/admin/support/tickets/${id}/messages`)
      .set(auth)
      .send({ body: 'Lo miramos ahora', isInternal: false });
    detail = await request(app.getHttpServer()).get(`/admin/support/tickets/${id}`).set(auth);
    expect(detail.body.firstResponseAt).not.toBeNull();
    const firstAt = detail.body.firstResponseAt as string;

    // Una segunda respuesta no la mueve.
    await request(app.getHttpServer())
      .post(`/admin/support/tickets/${id}/messages`)
      .set(auth)
      .send({ body: 'Ya está', isInternal: false });
    detail = await request(app.getHttpServer()).get(`/admin/support/tickets/${id}`).set(auth);
    expect(detail.body.firstResponseAt).toBe(firstAt);

    const after = (await request(app.getHttpServer()).get('/admin/support/stats').set(auth))
      .body as {
      awaitingFirstResponse: number;
      ticketsAnswered: number;
      answeredWithinDayPct: number;
    };
    expect(after.awaitingFirstResponse).toBe(before.awaitingFirstResponse);
    expect(after.ticketsAnswered).toBe(before.ticketsAnswered + 1);
    expect(after.answeredWithinDayPct).not.toBeNull();

    await request(app.getHttpServer()).get('/admin/support/stats').expect(401);
  });
});
