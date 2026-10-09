import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgresql://storageos:storageos@localhost:5432/storageos?schema=public';

/** Formulario de contacto de la web de TrasterOS. */
describe('Formulario de contacto de la web (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let adminAuth: { Authorization: string };
  const inbox = `contacto-${Date.now()}@example.com`;
  const visitor = `visitante-${Date.now()}@example.com`;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await prisma.platformWebsite.deleteMany();
    await prisma.platformContactMessage.deleteMany();
    app = await createTestApp();
    const admin = await seedSuperAdmin('contact');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await prisma.platformWebsite.deleteMany();
    await prisma.platformContactMessage.deleteMany();
    await prisma.$disconnect();
    await app.close();
    await cleanupSuperAdmins();
  });

  it('sin email no se muestra; configurado, guarda el mensaje y lo envía', async () => {
    const http = () => request(app.getHttpServer());
    const body = {
      name: 'Ana López',
      email: visitor,
      phone: '600123123',
      company: 'Trasteros Ana',
      units: 'De 50 a 200',
      profile: 'Gestiono trasteros o viviendas de otros propietarios',
      message: 'Quiero ver una demo del plan Administrador.',
      acceptPrivacy: true,
    };

    // Sin email de destino: el formulario no existe para la web.
    expect((await http().get('/platform-website').expect(200)).body.contactForm).toBeNull();
    await http().post('/platform-contact').send(body).expect(404);

    const saved = await http()
      .put('/admin/platform/contact')
      .set(adminAuth)
      .send({
        enabled: true,
        email: inbox,
        title: 'Hablemos',
        subtitle: 'Te respondemos hoy.',
        showPhone: true,
        requirePhone: true,
        showCompany: false,
        showUnits: true,
        showProfile: true,
      })
      .expect(200);
    expect(saved.body).toMatchObject({ email: inbox, requirePhone: true, showCompany: false });
    const form = (await http().get('/platform-website').expect(200)).body.contactForm;
    expect(form).toMatchObject({ title: 'Hablemos', requirePhone: true, showCompany: false });
    expect(form.email).toBeUndefined();

    // Teléfono obligatorio y aceptar la privacidad.
    await http()
      .post('/platform-contact')
      .send({ ...body, phone: '' })
      .expect(400);
    await http()
      .post('/platform-contact')
      .send({ ...body, acceptPrivacy: false })
      .expect(400);

    await http().post('/platform-contact').send(body).expect(204);
    const mail = await waitForEmail(inbox, { subjectIncludes: 'Contacto desde la web' });
    expect(mail.Subject).toBe('Contacto desde la web: Ana López');

    const list = await http().get('/admin/platform/contact/messages').set(adminAuth).expect(200);
    expect(list.body).toHaveLength(1);
    // La empresa no se pide (campo oculto): no se guarda aunque llegue.
    expect(list.body[0]).toMatchObject({ name: 'Ana López', company: null, emailSent: true });

    const done = await http()
      .post(`/admin/platform/contact/messages/${list.body[0].id}/handled`)
      .set(adminAuth)
      .send({ handled: true })
      .expect(200);
    expect(done.body.handledAt).toEqual(expect.any(String));

    // Un bot que rellena el campo oculto: 204 pero no se guarda nada.
    await http()
      .post('/platform-contact')
      .send({ ...body, hp: 'spam' })
      .expect(204);
    expect((await http().get('/admin/platform/contact/messages').set(adminAuth)).body).toHaveLength(
      1,
    );

    await http().get('/admin/platform/contact/messages').expect(401);
  });

  it('sale con el remitente del formulario; sin él, con el de «Mensajes del administrador»', async () => {
    const http = () => request(app.getHttpServer());
    const to = `buzon-${Date.now()}@example.com`;
    const send = (name: string) =>
      http()
        .post('/platform-contact')
        .send({
          name,
          email: visitor,
          message: 'Quiero información sobre el plan.',
          acceptPrivacy: true,
        })
        .expect(204);
    await http()
      .put('/admin/platform/contact')
      .set(adminAuth)
      .send({
        enabled: true,
        email: to,
        title: 'Hablemos',
        subtitle: '',
        showPhone: false,
        requirePhone: false,
        showCompany: false,
        showUnits: false,
        showProfile: false,
      })
      .expect(200);
    try {
      await http()
        .put('/admin/email-settings/senders')
        .set(adminAuth)
        .send({ default: {}, admin_messages: { email: 'admin@trasteros-e2e.local' } })
        .expect(200);
      await send('Remitente Admin');
      const first = await waitForEmail(to, { subjectIncludes: 'Remitente Admin' });
      expect(first.From.Address).toBe('admin@trasteros-e2e.local');

      await http()
        .put('/admin/email-settings/senders')
        .set(adminAuth)
        .send({
          default: {},
          admin_messages: { email: 'admin@trasteros-e2e.local' },
          web_contact: { email: 'web@trasteros-e2e.local' },
        })
        .expect(200);
      await send('Remitente Web');
      const second = await waitForEmail(to, { subjectIncludes: 'Remitente Web' });
      expect(second.From.Address).toBe('web@trasteros-e2e.local');
    } finally {
      await http().put('/admin/email-settings/senders').set(adminAuth).send({ default: {} });
    }
  });
});
