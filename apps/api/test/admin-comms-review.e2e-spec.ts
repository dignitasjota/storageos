import { getQueueToken } from '@nestjs/bullmq';
import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SupportAutoCloseCron } from '../src/modules/admin/support-autoclose.cron';
import { EmailService } from '../src/modules/email/email.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-comms-review@storageos.local';

interface TestQueue {
  pause: () => Promise<void>;
  obliterate: (opts: { force: boolean }) => Promise<void>;
  getJobs: (types: string[]) => Promise<{ data: Record<string, unknown> }[]>;
}

describe('Comunicación del panel admin: arreglos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let emailQueue: TestQueue;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Review',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    emailQueue = app.get<TestQueue>(getQueueToken('email'), { strict: false });
    await emailQueue.pause();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    try {
      await emailQueue.obliterate({ force: true });
    } catch {
      // best-effort
    }
    await app.close();
    await db.platformBanner.updateMany({ data: { enabled: false, endsAt: null } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('el correo directo no cuenta como respuesta del soporte, se lee y se cierra solo', async () => {
    const owner = await registerVerifiedUser(app, 'acrdirect');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const before = await request(app.getHttpServer())
      .get('/admin/support/stats')
      .set(auth())
      .expect(200);

    const sent = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/email`)
      .set(auth())
      .send({
        subject: 'Revisión de tu cuenta',
        body: 'Hola **Ana**, mira [esto](https://trasteros.pro).',
      });
    expect(sent.status).toBe(200);
    expect(sent.body.recipients).toBeGreaterThanOrEqual(1);

    const ticket = await db.supportTicket.findFirstOrThrow({ where: { tenantId: owner.tenantId } });
    expect(ticket.openedByAdmin).toBe(true);
    expect(ticket.firstResponseAt).toBeNull();

    // No cuenta en los tiempos de respuesta ni como «esperando tu respuesta».
    const after = await request(app.getHttpServer())
      .get('/admin/support/stats')
      .set(auth())
      .expect(200);
    expect(after.body.ticketsOpened).toBe(before.body.ticketsOpened);
    const waiting = await request(app.getHttpServer())
      .get('/support/tickets/waiting-count')
      .set(tenantAuth)
      .expect(200);
    expect(waiting.body.count).toBe(0);

    // «Mensajes de TrasterOS»: sin leer hasta que se abre.
    const page = await request(app.getHttpServer())
      .get('/support/platform-messages')
      .set(tenantAuth)
      .expect(200);
    expect(page.body.unread).toBe(1);
    expect(page.body.items[0].readAt).toBeNull();
    await request(app.getHttpServer())
      .post('/support/platform-messages/read')
      .set(tenantAuth)
      .expect(204);
    const read = await request(app.getHttpServer())
      .get('/support/platform-messages')
      .set(tenantAuth)
      .expect(200);
    expect(read.body.unread).toBe(0);

    // A los 14 días sin respuesta se cierra solo.
    await db.supportTicket.update({
      where: { id: ticket.id },
      data: { createdAt: new Date(Date.now() - 15 * 86_400_000) },
    });
    const closed = await app.get(SupportAutoCloseCron).run();
    expect(closed).toBeGreaterThanOrEqual(1);
    const now = await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(now.status).toBe('closed');
  });

  it('si el correo directo no sale, no se guarda nada', async () => {
    const owner = await registerVerifiedUser(app, 'acrfail');
    const spy = jest
      .spyOn(app.get(EmailService), 'sendRendered')
      .mockRejectedValue(new Error('proveedor caído'));
    try {
      const res = await request(app.getHttpServer())
        .post(`/admin/tenants/${owner.tenantId}/email`)
        .set(auth())
        .send({ subject: 'No llegará', body: 'Texto' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('email_send_failed');
    } finally {
      spy.mockRestore();
    }
    expect(await db.supportTicket.count({ where: { tenantId: owner.tenantId } })).toBe(0);
    expect(await db.tenantPlatformMessage.count({ where: { tenantId: owner.tenantId } })).toBe(0);
  });

  it('anuncio comercial: con enlace de baja, respeta la baja y no llega a los dados de baja', async () => {
    const a = await registerVerifiedUser(app, 'acrcoma');
    const b = await registerVerifiedUser(app, 'acrcomb');
    const c = await registerVerifiedUser(app, 'acrcomc');
    await db.tenant.update({ where: { id: c.tenantId }, data: { status: 'cancelled' } });
    await db.user.update({ where: { id: b.userId }, data: { platformNewsOptOutAt: new Date() } });

    const res = await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(auth())
      .send({
        audience: 'all',
        tenantIds: [a.tenantId, b.tenantId, c.tenantId],
        subject: 'Novedad',
        body: 'Ya puedes **probar** la función nueva.',
        commercial: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.tenants).toBe(1);
    expect(res.body.recipients).toBe(1);
    expect(res.body.optedOut).toBe(1);
    expect(res.body.skipped).toBe(2);

    const jobs = await emailQueue.getJobs(['paused', 'waiting', 'prioritized']);
    const job = jobs.find((j) => j.data.to === a.email.toLowerCase());
    expect(job).toBeDefined();
    const text = String(job?.data.text);
    expect(String(job?.data.html)).toContain('<strong>probar</strong>');
    expect((job?.data.headers as Record<string, string>)['List-Unsubscribe']).toContain(
      '/public/unsubscribe/',
    );
    const unsubToken = /\/unsubscribe\/([^\s]+)/.exec(text)?.[1];
    expect(unsubToken).toBeDefined();

    // El enlace de baja da de baja a ese usuario.
    const info = await request(app.getHttpServer())
      .get(`/public/unsubscribe/${unsubToken}`)
      .expect(200);
    expect(info.body.tenantName).toBe('TrasterOS');
    await request(app.getHttpServer()).post(`/public/unsubscribe/${unsubToken}`).expect(200);
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(user.platformNewsOptOutAt).not.toBeNull();

    // La auditoría dice que fue una selección.
    const log = await db.superAdminAuditLog.findFirstOrThrow({
      where: { action: 'admin.broadcast_sent' },
      orderBy: { occurredAt: 'desc' },
    });
    expect((log.changes as Record<string, unknown>).audience).toBe('selection');
  });

  it('banner con fecha de fin, novedades con su fecha y filtros validados', async () => {
    const owner = await registerVerifiedUser(app, 'acrbanner');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };

    const saved = await request(app.getHttpServer())
      .put('/admin/platform/banner')
      .set(auth())
      .send({ message: 'Parada técnica', level: 'critical', enabled: true, dismissible: true });
    expect(saved.status).toBe(200);
    expect(saved.body.dismissible).toBe(false);
    const visible = await request(app.getHttpServer()).get('/platform-banner').set(tenantAuth);
    expect(visible.body.message).toBe('Parada técnica');

    await request(app.getHttpServer())
      .put('/admin/platform/banner')
      .set(auth())
      .send({
        message: 'Parada técnica',
        level: 'info',
        enabled: true,
        endsAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(200);
    const gone = await request(app.getHttpServer()).get('/platform-banner').set(tenantAuth);
    expect(gone.body?.message).toBeUndefined();

    // Despublicar y volver a publicar conserva la fecha de la primera publicación.
    const created = await request(app.getHttpServer())
      .post('/admin/product-updates')
      .set(auth())
      .send({
        title: 'Algo nuevo',
        body: 'Texto de prueba',
        published: true,
        link: '/settings/web#seo',
      });
    expect(created.status).toBe(201);
    const first = created.body.publishedAt as string;
    await request(app.getHttpServer())
      .put(`/admin/product-updates/${created.body.id}`)
      .set(auth())
      .send({ title: 'Algo nuevo', body: 'Texto de prueba', published: false })
      .expect(200);
    const again = await request(app.getHttpServer())
      .put(`/admin/product-updates/${created.body.id}`)
      .set(auth())
      .send({ title: 'Algo nuevo', body: 'Texto de prueba', published: true })
      .expect(200);
    expect(again.body.publishedAt).toBe(first);
    await db.productUpdate.delete({ where: { id: created.body.id } });

    await request(app.getHttpServer()).get('/admin/email-log?status=nope').set(auth()).expect(400);
    await request(app.getHttpServer()).get('/admin/email-log?kind=nope').set(auth()).expect(400);
  });
});
