import { Prisma, PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ChatAlertsService } from '../src/modules/admin/chat-alerts.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';

describe('Plataforma del panel admin: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let adminId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.platformWebsite.deleteMany();
    await db.platformContactMessage.deleteMany();
    await db.platformLegalAcceptance.deleteMany();
    await db.platformLegalVersion.deleteMany();
    await db.platformAlertLog.deleteMany();
    app = await createTestApp();
    const admin = await seedSuperAdmin('platformfeat');
    adminId = admin.id;
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await db.platformAlertSettings.updateMany({
      data: {
        enabled: false,
        alertEmail: null,
        telegramBotTokenEncrypted: null,
        telegramChatId: null,
        dailyHour: 7,
      },
    });
    await db.platformAiSettings.updateMany({
      data: { apiKeyEncrypted: null, planLimits: Prisma.DbNull, monthlyCostAlertUsd: null },
    });
    await db.platformWebsite.deleteMany();
    await db.platformContactMessage.deleteMany();
    await db.platformLegalAcceptance.deleteMany();
    await db.platformLegalVersion.deleteMany();
    await db.platformLegalDocument.deleteMany({ where: { slug: 'terms' } });
    await app.close();
    await db.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('contacto: aviso por chat, responder, nota, responsable y CSV', async () => {
    const chat = app.get(ChatAlertsService);
    chat.sentForTests.length = 0;
    await http()
      .put('/admin/chat-alerts')
      .set(auth)
      .send({ telegramBotToken: TOKEN, telegramChatId: '-1001234567' })
      .expect(200);
    await http()
      .put('/admin/platform/contact')
      .set(auth)
      .send({
        enabled: true,
        email: `buzon-${Date.now()}@example.com`,
        title: 'Hablemos',
        subtitle: 'Te respondemos hoy.',
        showPhone: false,
        requirePhone: false,
        showCompany: true,
        showUnits: false,
        showProfile: false,
      })
      .expect(200);
    const visitor = `visita-${Date.now()}@example.com`;
    await http()
      .post('/platform-contact')
      .send({
        name: 'Marta Ruiz',
        email: visitor,
        company: 'Trasteros Ruiz',
        message: 'Quiero ver una demo, por favor.',
        acceptPrivacy: true,
      })
      .expect(204);
    // El aviso por chat va en segundo plano.
    for (let i = 0; i < 20 && chat.sentForTests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(chat.sentForTests.some((m) => m.text.includes('Marta Ruiz'))).toBe(true);

    const list = await http().get('/admin/platform/contact/messages').set(auth).expect(200);
    const id = list.body.items[0].id as string;

    await http()
      .put(`/admin/platform/contact/messages/${id}`)
      .set(auth)
      .send({ assignedToId: '00000000-0000-7000-8000-000000000000' })
      .expect(400);
    const upd = await http()
      .put(`/admin/platform/contact/messages/${id}`)
      .set(auth)
      .send({ note: 'Llamar el lunes', assignedToId: adminId })
      .expect(200);
    expect(upd.body).toMatchObject({ note: 'Llamar el lunes', assignedToId: adminId });
    expect(upd.body.assignedToName).toEqual(expect.any(String));

    const replied = await http()
      .post(`/admin/platform/contact/messages/${id}/reply`)
      .set(auth)
      .send({ subject: 'Re: tu demo', body: 'Hola Marta, **te llamamos** mañana.' })
      .expect(200);
    expect(replied.body.repliedAt).toEqual(expect.any(String));
    expect(replied.body.handledAt).toEqual(expect.any(String));
    const mail = await waitForEmail(visitor, { subjectIncludes: 'Re: tu demo' });
    expect(mail.Subject).toBe('Re: tu demo');
    const log = await db.platformEmailLog.findFirst({ where: { recipient: visitor } });
    expect(log?.kind).toBe('web_contact');

    const csv = await http().get('/admin/platform/contact/messages/export.csv').set(auth);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Marta Ruiz');
    expect(csv.text).toContain('Llamar el lunes');

    const alerts = await http().get('/admin/platform-alerts/log').set(auth).expect(200);
    expect(alerts.body.some((l: { kind: string }) => l.kind === 'contact')).toBe(true);
  });

  it('portada: textos propios y vuelta a los de serie', async () => {
    await http()
      .put('/admin/platform/website/home')
      .set(auth)
      .send({
        heroTitle: 'Gestiona tus trasteros sin papeles',
        heroSubtitle: null,
        heroNote: '',
        faq: [{ q: '¿Hay permanencia?', a: 'No, puedes darte de baja cuando quieras.' }],
      })
      .expect(200);
    const site = await http().get('/platform-website').expect(200);
    expect(site.body.home).toMatchObject({
      heroTitle: 'Gestiona tus trasteros sin papeles',
      heroSubtitle: null,
      heroNote: null,
    });
    expect(site.body.home.faq).toHaveLength(1);
    await http()
      .put('/admin/platform/website/home')
      .set(auth)
      .send({ heroTitle: null, heroSubtitle: null, heroNote: null, faq: null })
      .expect(200);
    expect((await http().get('/platform-website')).body.home.heroTitle).toBeNull();
  });

  it('legales: versiones, aviso a los tenants y aceptación del propietario', async () => {
    const owner = await registerVerifiedUser(app, 'legalaccept');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    expect((await http().get('/platform-legal-pending').set(tenantAuth)).body).toEqual([]);

    await http()
      .put('/admin/platform/legal/terms')
      .set(auth)
      .send({ title: 'Términos', content: '# Términos\n\nPrimera versión de los términos.' })
      .expect(200);
    await http()
      .put('/admin/platform/legal/terms')
      .set(auth)
      .send({
        title: 'Términos y Condiciones',
        content: '# Términos\n\nSegunda versión, con cambios importantes.',
        notifyTenants: true,
      })
      .expect(200);

    const versions = await http().get('/admin/platform/legal/terms/versions').set(auth);
    expect(versions.body).toHaveLength(2);
    expect(versions.body[0]).toMatchObject({ notifyTenants: true, acceptedCount: 0 });
    const detail = await http()
      .get(`/admin/platform/legal/terms/versions/${versions.body[1].id}`)
      .set(auth)
      .expect(200);
    expect(detail.body.content).toContain('Primera versión');

    const pending = await http().get('/platform-legal-pending').set(tenantAuth).expect(200);
    expect(pending.body).toHaveLength(1);
    await http()
      .post(`/platform-legal-pending/${pending.body[0].id}/accept`)
      .set(tenantAuth)
      .expect(204);
    expect((await http().get('/platform-legal-pending').set(tenantAuth)).body).toEqual([]);
    const after = await http().get('/admin/platform/legal/terms/versions').set(auth);
    expect(after.body[0].acceptedCount).toBe(1);

    const fill = await http().get('/admin/platform/legal-fill').set(auth).expect(200);
    expect(fill.body).toHaveProperty('values');
    expect(Array.isArray(fill.body.missing)).toBe(true);
  });

  it('IA: límite por plan, aviso de gasto, uso y prueba con una pregunta', async () => {
    const owner = await registerVerifiedUser(app, 'aiplanlimit');
    const saved = await http()
      .put('/admin/ai-settings')
      .set(auth)
      .send({ planLimits: { starter: 7 }, monthlyCostAlertUsd: 25, apiKey: 'sk-ant-test-1234' })
      .expect(200);
    expect(saved.body).toMatchObject({ planLimits: { starter: 7 }, monthlyCostAlertUsd: 25 });

    const usage = await http().get(`/admin/tenants/${owner.tenantId}/ai-usage`).set(auth);
    expect(usage.body.limit).toBe(7);

    const month = await http().get('/admin/ai-settings/usage').set(auth).expect(200);
    expect(month.body).toMatchObject({ alertUsd: 25, overAlert: false });

    const test = await http()
      .post('/admin/ai-settings/test')
      .set(auth)
      .send({ prompt: '¿Cómo reduzco la morosidad?' })
      .expect(200);
    expect(test.body.answer).toContain('¿Cómo reduzco la morosidad?');
  });

  it('alertas: varios emails, hora del aviso diario e historial', async () => {
    await http()
      .put('/admin/platform-alerts')
      .set(auth)
      .send({
        enabled: true,
        alertEmail: 'uno@storageos.local, no-es-un-email',
        notifyPastDue: true,
        notifyTrialExpiring: false,
        trialExpiringDays: 3,
      })
      .expect(400);
    const saved = await http()
      .put('/admin/platform-alerts')
      .set(auth)
      .send({
        enabled: true,
        alertEmail: 'Uno@storageos.local,dos@storageos.local',
        notifyPastDue: true,
        notifyTrialExpiring: false,
        trialExpiringDays: 3,
        dailyHour: 9,
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      alertEmail: 'uno@storageos.local, dos@storageos.local',
      dailyHour: 9,
    });

    const t = await registerVerifiedUser(app, 'alertmulti');
    await db.tenantSubscription.update({
      where: { tenantId: t.tenantId },
      data: { status: 'past_due' },
    });
    await db.tenant.update({ where: { id: t.tenantId }, data: { status: 'active' } });
    const run = await http().post('/admin/platform-alerts/run').set(auth).expect(200);
    expect(run.body.sent).toBe(true);
    const log = await http().get('/admin/platform-alerts/log').set(auth).expect(200);
    const daily = log.body.filter(
      (l: { kind: string; channel: string }) => l.kind === 'daily' && l.channel === 'email',
    );
    expect(daily.length).toBeGreaterThanOrEqual(2);
  });

  it('correo e IA de WhatsApp: consumo y uso', async () => {
    const usage = await http().get('/admin/email-settings/usage').set(auth).expect(200);
    expect(usage.body).toHaveProperty('primary');
    expect(Array.isArray(usage.body.providers)).toBe(true);
    const wa = await http().get('/admin/whatsapp-ai').set(auth).expect(200);
    expect(wa.body.usage).toMatchObject({ tenantsWithNumber: expect.any(Number) });
  });
});
