import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Correo saliente de la plataforma: el super admin elige Brevo o Resend y el
 * respaldo. En test no hay claves de API → el orden efectivo es la variable
 * (smtp/Mailpit), y la prueba se entrega por Mailpit.
 */
describe('Admin: correo saliente (e2e)', () => {
  let app: INestApplication;
  const db = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.DATABASE_ADMIN_URL ??
          'postgresql://storageos:storageos@localhost:5433/storageos?schema=public',
      },
    },
  });

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await db.platformEmailSettings.deleteMany();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.platformEmailSettings.deleteMany();
    await db.$disconnect();
    await cleanupSuperAdmins();
  });

  async function loginAs(role: 'superadmin' | 'support') {
    const admin = await seedSuperAdmin(`email-${role}`);
    if (role === 'support') {
      await db.superAdmin.update({ where: { id: admin.id }, data: { role: 'support' } });
    }
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    return { Authorization: `Bearer ${login.body.accessToken as string}` };
  }

  it('lee, cambia el proveedor y manda una prueba', async () => {
    await request(app.getHttpServer()).get('/admin/email-settings').expect(401);
    const auth = await loginAs('superadmin');

    const initial = await request(app.getHttpServer()).get('/admin/email-settings').set(auth);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      provider: null,
      fallbackEnabled: true,
      configured: { brevo: false, resend: false },
      effectiveOrder: ['smtp'],
    });

    const upd = await request(app.getHttpServer())
      .put('/admin/email-settings')
      .set(auth)
      .send({ provider: 'resend', fallbackEnabled: false });
    expect(upd.status).toBe(200);
    expect(upd.body.provider).toBe('resend');
    expect(upd.body.fallbackEnabled).toBe(false);
    // Sin RESEND_API_KEY no se puede usar: sigue la variable.
    expect(upd.body.effectiveOrder).toEqual(['smtp']);

    await request(app.getHttpServer())
      .put('/admin/email-settings')
      .set(auth)
      .send({ provider: 'mailchimp', fallbackEnabled: true })
      .expect(400);

    const to = `email-test-${Date.now()}@e2e.local`;
    const test = await request(app.getHttpServer())
      .post('/admin/email-settings/test')
      .set(auth)
      .send({ to });
    expect(test.status).toBe(200);
    expect(test.body.provider).toBe('smtp');
    await waitForEmail(to, { subjectIncludes: 'Prueba de correo' });
  });

  it('el rol support puede ver pero no cambiar ni probar', async () => {
    const auth = await loginAs('support');
    await request(app.getHttpServer()).get('/admin/email-settings').set(auth).expect(200);
    await request(app.getHttpServer())
      .put('/admin/email-settings')
      .set(auth)
      .send({ provider: 'brevo', fallbackEnabled: true })
      .expect(403);
    await request(app.getHttpServer())
      .post('/admin/email-settings/test')
      .set(auth)
      .send({ to: 'x@e2e.local' })
      .expect(403);
  });
});
