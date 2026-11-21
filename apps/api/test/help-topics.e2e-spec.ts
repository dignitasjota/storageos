import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import { HELP_TOPICS } from '@storageos/shared';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-help-topics-test@storageos.local';
const SUPPORT_EMAIL = 'support-help-topics-test@storageos.local';
const TOUCHED = ['alquilar', 'bajas', 'guia-de-prueba', 'otra-guia'];

const content = {
  group: 'Tu negocio',
  title: 'Guía de prueba',
  summary: 'Para probar las guías editables.',
  steps: ['Primer paso', 'Segundo paso'],
  links: [{ label: 'Hoy', href: '/today' }],
  keywords: 'probar editable',
};

describe('Guías de «Cómo funciona» (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminAuth: { Authorization: string };
  let supportAuth: { Authorization: string };
  let tenantAuth: { Authorization: string };

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.platformHelpTopic.deleteMany({ where: { topicId: { in: TOUCHED } } });
    await admin.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    for (const [email, role] of [
      [ADMIN_EMAIL, 'superadmin'],
      [SUPPORT_EMAIL, 'support'],
    ] as const) {
      await admin.superAdmin.create({
        data: { email, passwordHash: await argonHash('AdminTest!23'), fullName: email, role },
      });
    }
    app = await createTestApp();
    const login = async (email: string) =>
      (
        await request(app.getHttpServer())
          .post('/admin/auth/login')
          .send({ email, password: 'AdminTest!23' })
      ).body.accessToken as string;
    adminAuth = { Authorization: `Bearer ${await login(ADMIN_EMAIL)}` };
    supportAuth = { Authorization: `Bearer ${await login(SUPPORT_EMAIL)}` };
    const owner = await registerVerifiedUser(app, 'helptopics');
    tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await admin.platformHelpTopic.deleteMany({ where: { topicId: { in: TOUCHED } } });
    const ids = (
      await admin.superAdmin.findMany({
        where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } },
        select: { id: true },
      })
    ).map((a) => a.id);
    await admin.superAdminAuditLog.deleteMany({ where: { superAdminId: { in: ids } } });
    await admin.superAdminSession.deleteMany({ where: { superAdminId: { in: ids } } });
    await admin.superAdmin.deleteMany({ where: { id: { in: ids } } });
    await admin.$disconnect();
  });

  it('el tenant recibe las guías del código', async () => {
    const res = await request(app.getHttpServer()).get('/help-topics').set(tenantAuth).expect(200);
    const ids = (res.body as { id: string }[]).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['alquilar', 'bajas', 'domiciliacion']));
    expect(res.body).toHaveLength(HELP_TOPICS.length);
    expect(res.body[0]).toMatchObject({ imageUrl: null, videoEmbedUrl: null });

    await request(app.getHttpServer()).get('/help-topics').expect(401);
  });

  it('el admin cambia una, oculta otra y crea una nueva; el tenant lo ve', async () => {
    const http = () => request(app.getHttpServer());
    const edited = await http()
      .put('/admin/help-topics/alquilar')
      .set(adminAuth)
      .send({
        content: { ...content, group: 'Día a día', title: 'Alquilar, paso a paso' },
        videoUrl: 'https://youtu.be/abc123',
      })
      .expect(200);
    expect(edited.body).toMatchObject({
      id: 'alquilar',
      source: 'code',
      edited: true,
      title: 'Alquilar, paso a paso',
      videoEmbedUrl: 'https://www.youtube.com/embed/abc123',
    });

    await http().put('/admin/help-topics/bajas').set(adminAuth).send({ hidden: true }).expect(200);

    const created = await http()
      .post('/admin/help-topics')
      .set(adminAuth)
      .send({ id: 'guia-de-prueba', content, position: 0 })
      .expect(201);
    expect(created.body).toMatchObject({ id: 'guia-de-prueba', source: 'custom' });

    // Mismo id que una del código o que una ya creada: 409.
    await http()
      .post('/admin/help-topics')
      .set(adminAuth)
      .send({ id: 'alquilar', content })
      .expect(409);

    const tenant = await http().get('/help-topics').set(tenantAuth).expect(200);
    const list = tenant.body as { id: string; title: string; group: string }[];
    expect(list.find((t) => t.id === 'alquilar')?.title).toBe('Alquilar, paso a paso');
    expect(list.find((t) => t.id === 'bajas')).toBeUndefined();
    const negocio = list.filter((t) => t.group === 'Tu negocio');
    expect(negocio[0]?.id).toBe('guia-de-prueba');
    // El tenant no recibe los datos internos del panel.
    expect(list.find((t) => t.id === 'alquilar')).not.toHaveProperty('original');

    // El admin ve también las ocultas, con su estado.
    const adminList = await http().get('/admin/help-topics').set(adminAuth).expect(200);
    expect(
      (adminList.body as { id: string; hidden: boolean }[]).find((t) => t.id === 'bajas'),
    ).toMatchObject({ hidden: true });

    // Restaurar: la del código vuelve a su texto; la creada se borra.
    await http().delete('/admin/help-topics/alquilar').set(adminAuth).expect(204);
    await http().delete('/admin/help-topics/bajas').set(adminAuth).expect(204);
    await http().delete('/admin/help-topics/guia-de-prueba').set(adminAuth).expect(204);
    await http().delete('/admin/help-topics/guia-de-prueba').set(adminAuth).expect(404);
    const after = await http().get('/help-topics').set(tenantAuth).expect(200);
    const original = HELP_TOPICS.find((t) => t.id === 'alquilar')!;
    expect(
      (after.body as { id: string; title: string }[]).find((t) => t.id === 'alquilar')?.title,
    ).toBe(original.title);
    expect(after.body).toHaveLength(HELP_TOPICS.length);
  });

  it('soporte lee pero no escribe', async () => {
    const http = () => request(app.getHttpServer());
    await http().get('/admin/help-topics').set(supportAuth).expect(200);
    await http()
      .put('/admin/help-topics/alquilar')
      .set(supportAuth)
      .send({ hidden: true })
      .expect(403);
    await http()
      .post('/admin/help-topics')
      .set(supportAuth)
      .send({ id: 'otra-guia', content })
      .expect(403);
    await http().delete('/admin/help-topics/alquilar').set(supportAuth).expect(403);
    // Un tenant no entra al panel admin.
    await http().get('/admin/help-topics').set(tenantAuth).expect(401);
  });

  it('rechaza enlaces externos y vídeos que no son de YouTube o Vimeo', async () => {
    const http = () => request(app.getHttpServer());
    for (const href of ['https://ejemplo.com', '//ejemplo.com', 'javascript:alert(1)']) {
      await http()
        .post('/admin/help-topics')
        .set(adminAuth)
        .send({ id: 'otra-guia', content: { ...content, links: [{ label: 'Fuera', href }] } })
        .expect(400);
    }
    await http()
      .put('/admin/help-topics/alquilar')
      .set(adminAuth)
      .send({ videoUrl: 'https://ejemplo.com/video.mp4' })
      .expect(400);
    await http()
      .put('/admin/help-topics/alquilar')
      .set(adminAuth)
      .send({ imageKey: 'otra-carpeta/x.png' })
      .expect(400);
    // Una guía que no existe no se puede cambiar.
    await http()
      .put('/admin/help-topics/no-existe')
      .set(adminAuth)
      .send({ hidden: true })
      .expect(404);
  });
});
