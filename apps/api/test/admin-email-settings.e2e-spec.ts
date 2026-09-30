import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
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
    await cleanupTestTenants();
    await db.platformEmailSettings.deleteMany();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.platformEmailSettings.deleteMany();
    await db.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
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

  it('lista los dominios de Brevo que ya no usa ningún tenant y permite borrarlos', async () => {
    const auth = await loginAs('superadmin');
    const owner = await registerVerifiedUser(app, 'brevounused');
    await setTenantPlan(owner.slug, 'pro');
    const tAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const stamp = Date.now().toString(36);
    const oldDomain = `viejo-${stamp}.es`;
    const newDomain = `nuevo-${stamp}.es`;

    // El tenant da de alta un dominio y luego lo cambia por otro: el viejo
    // sigue en Brevo (la app nunca lo borra) y ya no lo usa nadie.
    for (const domain of [oldDomain, newDomain]) {
      await request(app.getHttpServer())
        .put('/settings/tenant/email-domain')
        .set(tAuth)
        .send({ domain })
        .expect(200);
    }

    // Estado del dominio del remitente de la plataforma en cada proveedor.
    const platform = await request(app.getHttpServer())
      .get('/admin/email-settings/platform-domain')
      .set(auth)
      .expect(200);
    expect(platform.body.domain).toMatch(/\./);
    expect(platform.body.brevo).toBe('authenticated'); // stub de Brevo en test
    expect(platform.body.resend).toBe('no_key');

    const list = await request(app.getHttpServer())
      .get('/admin/email-settings/brevo-domains/unused')
      .set(auth)
      .expect(200);
    const names = (list.body as { domain: string }[]).map((d) => d.domain);
    expect(names).toContain(oldDomain);
    expect(names).not.toContain(newDomain);

    // Uno en uso no se puede borrar.
    const inUse = await request(app.getHttpServer())
      .delete(`/admin/email-settings/brevo-domains/${newDomain}`)
      .set(auth);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('email_domain_in_use');

    await request(app.getHttpServer())
      .delete(`/admin/email-settings/brevo-domains/${oldDomain}`)
      .set(auth)
      .expect(204);
    const after = await request(app.getHttpServer())
      .get('/admin/email-settings/brevo-domains/unused')
      .set(auth);
    expect((after.body as { domain: string }[]).map((d) => d.domain)).not.toContain(oldDomain);

    await request(app.getHttpServer())
      .delete('/admin/email-settings/brevo-domains/no%20valido')
      .set(auth)
      .expect(400);
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
    await request(app.getHttpServer())
      .get('/admin/email-settings/brevo-domains/unused')
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .delete('/admin/email-settings/brevo-domains/cualquiera.es')
      .set(auth)
      .expect(403);
  });
});
