import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ChatAlertsService } from '../src/modules/admin/chat-alerts.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXX';

/** Avisos del panel admin por Telegram y Slack (sin red: se guardan en memoria). */
describe('Admin: avisos por chat (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let chat: ChatAlertsService;
  let auth: Record<string, string>;
  let supportAuth: Record<string, string>;

  async function login(email: string, password: string) {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password });
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    chat = app.get(ChatAlertsService);
    const sa = await seedSuperAdmin('chat-super');
    auth = await login(sa.email, sa.password);
    const sup = await seedSuperAdmin('chat-support');
    await db.superAdmin.update({ where: { email: sup.email }, data: { role: 'support' } });
    supportAuth = await login(sup.email, sup.password);
  });

  afterAll(async () => {
    await request(app.getHttpServer()).put('/admin/chat-alerts').set(auth).send({
      telegramBotToken: '',
      telegramChatId: '',
      slackWebhookUrl: '',
      dailyEnabled: false,
      weeklyEnabled: false,
    });
    await app.close();
    await db.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('guarda los canales sin devolver secretos, prueba y manda lo urgente del «Hoy»', async () => {
    const http = () => request(app.getHttpServer());
    await http()
      .put('/admin/chat-alerts')
      .set(auth)
      .send({ slackWebhookUrl: 'https://evil.example.com/hook' })
      .expect(400);
    await http()
      .put('/admin/chat-alerts')
      .set(supportAuth)
      .send({ dailyEnabled: true })
      .expect(403);

    const saved = await http()
      .put('/admin/chat-alerts')
      .set(auth)
      .send({ telegramBotToken: TOKEN, telegramChatId: '-1001234567', slackWebhookUrl: SLACK })
      .expect(200);
    expect(saved.body).toEqual({
      telegramConfigured: true,
      telegramChatId: '-1001234567',
      slackConfigured: true,
      dailyEnabled: false,
      weeklyEnabled: false,
    });
    const row = await db.platformAlertSettings.findFirst();
    expect(row?.telegramBotTokenEncrypted).not.toContain('AAFake');
    expect(row?.slackWebhookUrlEncrypted).not.toContain('hooks.slack.com');

    chat.sentForTests.length = 0;
    const test = await http().post('/admin/chat-alerts/test').set(auth).expect(200);
    expect(test.body).toMatchObject({ sent: true, telegram: 'sent', slack: 'sent' });
    expect(chat.sentForTests.map((m) => m.channel).sort()).toEqual(['slack', 'telegram']);

    // Un ticket sin responder → el aviso diario lo cuenta.
    const owner = await registerVerifiedUser(app, 'chatalert');
    await http()
      .post('/support/tickets')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ subject: 'Necesito ayuda', body: 'Hola', priority: 'high' })
      .expect(201);
    chat.sentForTests.length = 0;
    const daily = await http().post('/admin/chat-alerts/daily/run').set(auth).expect(200);
    expect(daily.body.sent).toBe(true);
    const text = chat.sentForTests[0]?.text ?? '';
    expect(text).toMatch(/TrasterOS · Hoy: \d+ cosa\(s\) urgente\(s\)/);
    expect(text).toMatch(/\d+ tickets sin responder/);
    expect(text).toContain('/admin/today');

    // Aviso diario apagado → el cron no manda nada.
    expect((await chat.sendDaily()).reason).toBe('disabled');

    // Resumen semanal solo por chat (email apagado).
    await http().put('/admin/chat-alerts').set(auth).send({ weeklyEnabled: true }).expect(200);
    chat.sentForTests.length = 0;
    const weekly = await http().post('/admin/weekly-digest/run').set(auth).expect(200);
    expect(weekly.body.sent).toBe(true);
    expect(chat.sentForTests[0]?.text).toContain('Resumen semanal de KPIs');

    // Quitar los canales.
    const cleared = await http()
      .put('/admin/chat-alerts')
      .set(auth)
      .send({ telegramBotToken: '', slackWebhookUrl: '' })
      .expect(200);
    expect(cleared.body).toMatchObject({ telegramConfigured: false, slackConfigured: false });
    const none = await http().post('/admin/chat-alerts/test').set(auth).expect(200);
    expect(none.body).toMatchObject({ sent: false, reason: 'no_channel' });
  });
});
