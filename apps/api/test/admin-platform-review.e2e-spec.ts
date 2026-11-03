import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { FilesService } from '../src/modules/files/files.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Plataforma del panel admin: arreglos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let supportAuth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    const admin = await seedSuperAdmin('platformreview');
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const support = await seedSuperAdmin('platformsupport');
    await db.superAdmin.update({ where: { id: support.id }, data: { role: 'support' } });
    const sLogin = await http()
      .post('/admin/auth/login')
      .send({ email: support.email, password: support.password });
    supportAuth = { Authorization: `Bearer ${sLogin.body.accessToken}` };
  });

  afterAll(async () => {
    await db.platformAlertSettings.updateMany({ data: { enabled: false } });
    await app.close();
    await db.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('aviso diario: escapado, sin exentos, en el historial y solo para el superadmin', async () => {
    const bad = await registerVerifiedUser(app, 'aprbad', {
      tenantName: '<b>Trasteros</b> [x](javascript:alert(1))',
    });
    const exempt = await registerVerifiedUser(app, 'aprexempt', { tenantName: 'Exenta SL' });
    for (const t of [bad, exempt]) {
      await db.tenantSubscription.update({
        where: { tenantId: t.tenantId },
        data: { status: 'past_due' },
      });
      await db.tenant.update({ where: { id: t.tenantId }, data: { status: 'active' } });
    }
    await db.tenant.update({ where: { id: exempt.tenantId }, data: { billingExempt: true } });

    await http()
      .put('/admin/platform-alerts')
      .set(auth)
      .send({
        enabled: true,
        alertEmail: 'alertas-review@storageos.local',
        notifyPastDue: true,
        notifyTrialExpiring: false,
        trialExpiringDays: 3,
      })
      .expect(200);

    await http().post('/admin/platform-alerts/run').set(supportAuth).expect(403);
    const run = await http().post('/admin/platform-alerts/run').set(auth).expect(200);
    expect(run.body.sent).toBe(true);

    const log = await db.platformEmailLog.findFirstOrThrow({
      where: { recipient: 'alertas-review@storageos.local', kind: 'admin_alert' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.bodyHtml).not.toContain('<b>Trasteros</b>');
    expect(log.bodyHtml).not.toContain('href="javascript');
    expect(log.bodyHtml).toContain(`/admin/tenants/${bad.tenantId}`);
    expect(log.bodyText).not.toContain('Exenta SL');
  });

  it('el correo de prueba queda en el historial', async () => {
    const to = `prueba-${Date.now()}@storageos.local`;
    await http().post('/admin/email-settings/test').set(auth).send({ to }).expect(200);
    const log = await db.platformEmailLog.findFirst({ where: { recipient: to } });
    expect(log?.kind).toBe('admin_alert');
  });

  it('contacto: buscador, filtro, borrado y retención', async () => {
    await db.platformContactMessage.createMany({
      data: [
        { name: 'Marta Ruiz', email: 'marta@example.com', message: 'Quiero una demo, por favor.' },
        {
          name: 'Luis Gil',
          email: 'luis@example.com',
          message: 'Tengo 300 trasteros y quiero migrar.',
          handledAt: new Date(),
        },
      ],
    });
    const found = await http()
      .get('/admin/platform/contact/messages?search=migrar')
      .set(auth)
      .expect(200);
    expect(found.body.items.map((m: { name: string }) => m.name)).toEqual(['Luis Gil']);
    const pending = await http()
      .get('/admin/platform/contact/messages?handled=false&search=Marta')
      .set(auth)
      .expect(200);
    expect(pending.body.items).toHaveLength(1);

    const id = pending.body.items[0].id as string;
    await http().delete(`/admin/platform/contact/messages/${id}`).set(supportAuth).expect(403);
    await http().delete(`/admin/platform/contact/messages/${id}`).set(auth).expect(204);
    expect(await db.platformContactMessage.count({ where: { id } })).toBe(0);
    await db.platformContactMessage.deleteMany({ where: { email: 'luis@example.com' } });
  });

  it('logo: no acepta bytes que no son imagen y borra el anterior', async () => {
    const files = app.get(FilesService);
    const up = async () =>
      (
        await http()
          .post('/admin/platform/website/logo-upload-url')
          .set(auth)
          .send({ mimeType: 'image/png', sizeBytes: 100 })
          .expect(200)
      ).body.key as string;

    const fake = await up();
    await files.putObject({
      bucket: 'public',
      key: fake,
      body: Buffer.from('<svg onload=alert(1)>'),
      contentType: 'image/png',
    });
    await http().put('/admin/platform/website/logo').set(auth).send({ key: fake }).expect(400);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const first = await up();
    await files.putObject({ bucket: 'public', key: first, body: png, contentType: 'image/png' });
    await http().put('/admin/platform/website/logo').set(auth).send({ key: first }).expect(200);
    const second = await up();
    await files.putObject({ bucket: 'public', key: second, body: png, contentType: 'image/png' });
    await http().put('/admin/platform/website/logo').set(auth).send({ key: second }).expect(200);
    // El primero ya no está en el bucket.
    await expect(files.getObject({ bucket: 'public', key: first })).rejects.toBeTruthy();
    await http().put('/admin/platform/website/logo').set(auth).send({ key: null }).expect(200);
  });

  it('legales: no guarda un texto casi vacío', async () => {
    const res = await http()
      .put('/admin/platform/legal/cookies')
      .set(auth)
      .send({ title: 'Cookies', content: 'corto' });
    expect(res.status).toBe(400);
  });
});
