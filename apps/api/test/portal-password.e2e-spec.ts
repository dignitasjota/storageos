import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Login del inquilino por email + contraseña (opt-in, alternativa al magic link):
 * entra por magic link → fija contraseña desde el perfil → luego entra con
 * email+contraseña.
 */
describe('Portal — login por contraseña (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function magicLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer()).post('/portal/login/consume').send({ token });
    return consume.body.accessToken as string;
  }

  it('fijar contraseña desde el perfil y luego entrar con email+contraseña', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pwd');
    const email = `pwd-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    // Sin contraseña aún → el login por contraseña falla.
    const before = await request(app.getHttpServer())
      .post('/portal/login/password')
      .send({ tenantSlug: owner.slug, email, password: 'Secreto123' });
    expect(before.status).toBe(401);
    expect(before.body.code).toBe('portal_login_failed');

    // Entra por magic link y comprueba el perfil (aún sin contraseña).
    const portalToken = await magicLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };
    const profile = await request(app.getHttpServer()).get('/portal/me/profile').set(pAuth);
    expect(profile.body.hasPortalPassword).toBe(false);

    // Fija la contraseña (mín. 8 caracteres).
    await request(app.getHttpServer())
      .post('/portal/me/password')
      .set(pAuth)
      .send({ password: 'Secreto123' })
      .expect(204);

    // El perfil ya la refleja.
    const after = await request(app.getHttpServer()).get('/portal/me/profile').set(pAuth);
    expect(after.body.hasPortalPassword).toBe(true);

    // Ahora entra con email + contraseña → sesión válida.
    const login = await request(app.getHttpServer())
      .post('/portal/login/password')
      .send({ tenantSlug: owner.slug, email, password: 'Secreto123' });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.customerName).toBeTruthy();

    // La sesión obtenida sirve para consultar sus datos.
    const me = await request(app.getHttpServer())
      .get('/portal/me/profile')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);

    // Contraseña incorrecta → 401 genérico (no filtra).
    const wrong = await request(app.getHttpServer())
      .post('/portal/login/password')
      .send({ tenantSlug: owner.slug, email, password: 'otra-mala' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('portal_login_failed');
  });

  it('set-password exige sesión de portal; contraseña corta → 400', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pwd-guard');
    const email = `pwdg-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    // Sin sesión → 401.
    await request(app.getHttpServer())
      .post('/portal/me/password')
      .send({ password: 'Secreto123' })
      .expect(401);

    // Con sesión pero contraseña < 8 → 400.
    const portalToken = await magicLogin(owner.slug, email);
    await request(app.getHttpServer())
      .post('/portal/me/password')
      .set({ Authorization: `Bearer ${portalToken}` })
      .send({ password: 'corta' })
      .expect(400);
  });

  it('reset por email (forgot → reset) fija la contraseña y auto-loguea', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pwd-reset');
    const email = `reset-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    // Solicita el enlace de reset por email.
    await request(app.getHttpServer())
      .post('/portal/login/forgot')
      .send({ tenantSlug: owner.slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Restablece' });
    const token = mail.Text.match(/reset\?token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();

    // Fija la contraseña con el token → sesión (auto-login).
    const reset = await request(app.getHttpServer())
      .post('/portal/login/reset')
      .send({ token, password: 'NuevaClave1' });
    expect(reset.status).toBe(200);
    expect(reset.body.accessToken).toBeTruthy();

    // El token es de un solo uso → replay falla.
    await request(app.getHttpServer())
      .post('/portal/login/reset')
      .send({ token, password: 'Otra12345' })
      .expect(401);

    // Y ya puede entrar con la nueva contraseña.
    const login = await request(app.getHttpServer())
      .post('/portal/login/password')
      .send({ tenantSlug: owner.slug, email, password: 'NuevaClave1' });
    expect(login.status).toBe(200);
  });

  it('staff: enlace de reset + desactivar el acceso por contraseña', async () => {
    const owner = await registerVerifiedUser(app, 'portal-pwd-staff');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `staff-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // El staff genera un enlace de reset (para repartir a mano).
    const gen = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link/password-reset-link`)
      .set(auth);
    expect(gen.status).toBe(201);
    const token = gen.body.url.match(/reset\?token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();

    // El inquilino usa ese enlace → contraseña fijada + acceso activado.
    await request(app.getHttpServer())
      .post('/portal/login/reset')
      .send({ token, password: 'ClaveStaff1' })
      .expect(200);
    const enabled = await request(app.getHttpServer()).get(`/customers/${customerId}`).set(auth);
    expect(enabled.body.portalAccessEnabled).toBe(true);

    // El staff desactiva el acceso por contraseña.
    await request(app.getHttpServer())
      .delete(`/customers/${customerId}/portal-link/password`)
      .set(auth)
      .expect(204);
    const disabled = await request(app.getHttpServer()).get(`/customers/${customerId}`).set(auth);
    expect(disabled.body.portalAccessEnabled).toBe(false);

    // Ya no puede entrar con contraseña.
    await request(app.getHttpServer())
      .post('/portal/login/password')
      .send({ tenantSlug: owner.slug, email, password: 'ClaveStaff1' })
      .expect(401);
  });
});
