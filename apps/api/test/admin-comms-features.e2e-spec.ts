import { getQueueToken } from '@nestjs/bullmq';
import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformAnnouncementsService } from '../src/modules/admin/platform-announcements.service';
import { EmailService } from '../src/modules/email/email.service';
import { FilesService } from '../src/modules/files/files.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-comms-features@storageos.local';

interface Job {
  data: Record<string, unknown>;
}
interface TestQueue {
  pause: () => Promise<void>;
  obliterate: (opts: { force: boolean }) => Promise<void>;
  getJobs: (types: string[]) => Promise<Job[]>;
}

describe('Comunicación del panel admin: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let emailQueue: TestQueue;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const jobs = async () => emailQueue.getJobs(['paused', 'waiting', 'prioritized']);

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Features',
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
    await db.platformBanner.deleteMany({ where: { message: { startsWith: 'e2e-' } } });
    await db.platformAnnouncement.deleteMany({ where: { subject: { startsWith: 'e2e-' } } });
    await db.platformNpsSurvey.deleteMany({ where: { name: { startsWith: 'e2e-' } } });
    await db.platformEmailTemplate.deleteMany({});
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('anuncio: segmento, programado, variables, historial y reenvío', async () => {
    const pro = await registerVerifiedUser(app, 'acfpro', { fullName: 'Ana López' });
    const other = await registerVerifiedUser(app, 'acfother');
    await setTenantPlan(pro.slug, 'pro');
    const segment = { audience: 'all', tenantIds: undefined, plans: ['pro'] };

    const preview = await request(app.getHttpServer())
      .post('/admin/announcements/preview')
      .set(auth())
      .send({
        segment: { audience: 'all', tenantIds: [pro.tenantId, other.tenantId], plans: ['pro'] },
      })
      .expect(200);
    // Con tenants concretos manda la selección.
    expect(preview.body.tenants).toBe(2);

    const draft = await request(app.getHttpServer())
      .post('/admin/announcements/drafts')
      .set(auth())
      .send({
        subject: 'e2e-Hola {empresa}',
        body: 'Hola {nombre}, novedad para **{empresa}**.',
        segment: { ...segment, tenantIds: [pro.tenantId, other.tenantId].slice(0, 1) },
      })
      .expect(201);
    expect(draft.body.status).toBe('draft');

    // Programado para dentro de una hora y luego «llega» la hora.
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await request(app.getHttpServer())
      .post(`/admin/announcements/${draft.body.id}/send`)
      .set(auth())
      .send({ scheduledFor: at })
      .expect(200);
    expect(scheduled.body.status).toBe('scheduled');
    const sent = await app
      .get(PlatformAnnouncementsService)
      .runScheduled(new Date(Date.now() + 2 * 3_600_000));
    expect(sent).toBeGreaterThanOrEqual(1);

    const job = (await jobs()).find(
      (j) => j.data.to === pro.email.toLowerCase() && j.data.announcementId === draft.body.id,
    );
    expect(job).toBeDefined();
    expect(String(job?.data.subject)).toBe(`e2e-Hola Test acfpro`);
    expect(String(job?.data.text)).toContain('Hola Ana, novedad para Test acfpro.');

    // El historial guarda el correo con su anuncio y su HTML.
    const email = app.get(EmailService);
    await email.sendRendered({
      to: pro.email,
      kind: 'admin_message',
      subject: String(job?.data.subject),
      html: String(job?.data.html),
      text: String(job?.data.text),
      announcementId: draft.body.id,
    });
    const history = await request(app.getHttpServer())
      .get('/admin/announcements/history')
      .set(auth())
      .expect(200);
    const row = history.body.find((a: { id: string }) => a.id === draft.body.id);
    expect(row.status).toBe('sent');
    expect(row.recipientsCount).toBe(1);

    const log = await request(app.getHttpServer())
      .get(`/admin/email-log?announcementId=${draft.body.id}`)
      .set(auth())
      .expect(200);
    expect(log.body.items[0].hasHtml).toBe(true);
    const body = await request(app.getHttpServer())
      .get(`/admin/email-log/${log.body.items[0].id}/body`)
      .set(auth())
      .expect(200);
    expect(body.body.html).toContain('<strong>Test acfpro</strong>');

    // Duplicar crea otro borrador; un enviado no se edita.
    const copy = await request(app.getHttpServer())
      .post(`/admin/announcements/${draft.body.id}/duplicate`)
      .set(auth())
      .expect(201);
    expect(copy.body.status).toBe('draft');
    await request(app.getHttpServer())
      .put(`/admin/announcements/${draft.body.id}`)
      .set(auth())
      .send({ subject: 'e2e-otro', body: 'x', segment })
      .expect(400);

    // Todos lo recibieron: nada que reenviar.
    const resend = await request(app.getHttpServer())
      .post(`/admin/announcements/${draft.body.id}/resend-missing`)
      .set(auth())
      .expect(200);
    expect(resend.body.recipients).toBe(0);
  });

  it('banners por plan, prioridad e inicio', async () => {
    const pro = await registerVerifiedUser(app, 'acfbanpro');
    await setTenantPlan(pro.slug, 'pro');
    const starter = await registerVerifiedUser(app, 'acfbanst');
    const create = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/admin/platform/banners')
        .set(auth())
        .send(body)
        .expect(201);
    await create({
      message: 'e2e-para pro',
      plans: ['pro'],
      priority: 90,
      linkUrl: '/settings/web',
      linkLabel: 'Ver',
    });
    await create({ message: 'e2e-para todos', priority: 80 });
    await create({
      message: 'e2e-mañana',
      priority: 99,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const seenPro = await request(app.getHttpServer())
      .get('/platform-banner')
      .set({ Authorization: `Bearer ${pro.accessToken}` });
    expect(seenPro.body.message).toBe('e2e-para pro');
    expect(seenPro.body.linkUrl).toBe('/settings/web');
    const seenStarter = await request(app.getHttpServer())
      .get('/platform-banner')
      .set({ Authorization: `Bearer ${starter.accessToken}` });
    expect(seenStarter.body.message).toBe('e2e-para todos');
    const list = await request(app.getHttpServer()).get('/admin/platform/banners').set(auth());
    const tomorrow = list.body.find((b: { message: string }) => b.message === 'e2e-mañana');
    expect(tomorrow.live).toBe(false);
  });

  it('mensaje directo sin respuesta y con adjunto', async () => {
    const owner = await registerVerifiedUser(app, 'acfdirect');
    const up = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/email/upload-url`)
      .set(auth())
      .send({ fileName: 'Condiciones 2027.pdf', mimeType: 'application/pdf', size: 20 })
      .expect(200);
    await app.get(FilesService).putObject({
      bucket: 'uploads',
      key: up.body.key,
      body: Buffer.from('%PDF-1.4\n%prueba\n'),
      contentType: 'application/pdf',
    });
    const sent = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/email`)
      .set(auth())
      .send({
        subject: 'Cambio de condiciones',
        body: 'Te adjuntamos las nuevas condiciones.',
        replyExpected: false,
        attachments: [
          { key: up.body.key, name: 'Condiciones 2027.pdf', mimeType: 'application/pdf', size: 20 },
        ],
      });
    expect(sent.status).toBe(200);
    expect(await db.supportTicket.count({ where: { tenantId: owner.tenantId } })).toBe(0);
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const page = await request(app.getHttpServer())
      .get('/support/platform-messages')
      .set(tenantAuth)
      .expect(200);
    expect(page.body.items[0].ticketId).toBeNull();
    expect(page.body.items[0].attachments[0].name).toBe('Condiciones 2027.pdf');
    const file = await request(app.getHttpServer())
      .get(`/support/platform-messages/${page.body.items[0].id}/attachments/0`)
      .set(tenantAuth)
      .expect(200);
    expect(file.body.url).toContain('Condiciones');

    // Un adjunto de otro tenant no vale.
    const bad = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/email`)
      .set(auth())
      .send({
        subject: 'Ajeno',
        body: 'x',
        attachments: [
          {
            key: 'otro/platform-messages/x/a.pdf',
            name: 'a.pdf',
            mimeType: 'application/pdf',
            size: 1,
          },
        ],
      });
    expect(bad.status).toBe(400);
  });

  it('correos automáticos editables', async () => {
    const list = await request(app.getHttpServer())
      .get('/admin/email-templates')
      .set(auth())
      .expect(200);
    expect(list.body.map((t: { code: string }) => t.code)).toEqual([
      'welcome',
      'trial_ending',
      'trial_ended',
      'past_due',
    ]);
    const saved = await request(app.getHttpServer())
      .put('/admin/email-templates/past_due')
      .set(auth())
      .send({
        subject: 'Falta tu pago, {empresa}',
        body: 'Hola {empresa}, paga aquí: {enlace_pago}',
      })
      .expect(200);
    expect(saved.body.find((t: { code: string }) => t.code === 'past_due').custom).toBe(true);
    await request(app.getHttpServer())
      .put('/admin/email-templates/nope')
      .set(auth())
      .send({ subject: 'abc', body: 'abc' })
      .expect(400);
    const reset = await request(app.getHttpServer())
      .delete('/admin/email-templates/past_due')
      .set(auth())
      .expect(200);
    expect(reset.body.find((t: { code: string }) => t.code === 'past_due').custom).toBe(false);
  });

  it('encuesta NPS: envío, respuesta por enlace y resultados', async () => {
    const owner = await registerVerifiedUser(app, 'acfnps');
    const survey = await request(app.getHttpServer())
      .post('/admin/nps-surveys')
      .set(auth())
      .send({ name: 'e2e-NPS otoño', segment: { audience: 'all', tenantIds: [owner.tenantId] } })
      .expect(201);
    const sent = await request(app.getHttpServer())
      .post(`/admin/nps-surveys/${survey.body.id}/send`)
      .set(auth())
      .expect(200);
    expect(sent.body.sent).toBe(1);
    const job = (await jobs()).find(
      (j) => j.data.to === owner.email.toLowerCase() && String(j.data.text).includes('/nps/'),
    );
    const npsToken = /\/nps\/(\S+)/.exec(String(job?.data.text))?.[1];
    expect(npsToken).toBeDefined();

    const pub = await request(app.getHttpServer())
      .get(`/public/platform-nps/${npsToken}`)
      .expect(200);
    expect(pub.body.answered).toBe(false);
    await request(app.getHttpServer())
      .post(`/public/platform-nps/${npsToken}`)
      .send({ score: 9, comment: 'Muy útil' })
      .expect(200);
    await request(app.getHttpServer()).get('/public/platform-nps/xx.yy').expect(404);

    const detail = await request(app.getHttpServer())
      .get(`/admin/nps-surveys/${survey.body.id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.nps).toBe(100);
    expect(detail.body.answers[0].comment).toBe('Muy útil');
  });

  it('correos enviados: estadísticas, CSV y reenvío', async () => {
    const stats = await request(app.getHttpServer())
      .get('/admin/email-log/stats?weeks=4')
      .set(auth())
      .expect(200);
    expect(stats.body.weeks).toHaveLength(4);
    const csv = await request(app.getHttpServer())
      .get('/admin/email-log/export')
      .set(auth())
      .expect(200);
    expect(csv.text).toContain('Destinatario');
    await request(app.getHttpServer()).get('/admin/email-log/problems').set(auth()).expect(200);
    const log = await request(app.getHttpServer())
      .get('/admin/email-log?kind=admin_message')
      .set(auth())
      .expect(200);
    const withHtml = log.body.items.find((i: { hasHtml: boolean }) => i.hasHtml);
    await request(app.getHttpServer())
      .post(`/admin/email-log/${withHtml.id}/resend`)
      .set(auth())
      .expect(200);
  });
});
