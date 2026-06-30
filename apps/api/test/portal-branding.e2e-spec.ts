import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal — white-label / marca (e2e)', () => {
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

  it('el staff configura la marca y el portal del inquilino la refleja', async () => {
    const owner = await registerVerifiedUser(app, 'branding');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `branding-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    // Estado inicial: sin marca.
    const initial = await request(app.getHttpServer()).get('/settings/tenant/branding').set(auth);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ portalBrandColor: null, portalLogoUrl: null });

    // Configurar.
    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ portalBrandColor: '#ff6600', portalLogoUrl: 'https://cdn.example.com/logo.png' });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({
      portalBrandColor: '#ff6600',
      portalLogoUrl: 'https://cdn.example.com/logo.png',
    });

    // El portal del inquilino lo recibe en la sesión.
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: owner.slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    expect(consume.body.brandColor).toBe('#ff6600');
    expect(consume.body.logoUrl).toBe('https://cdn.example.com/logo.png');

    // '' borra el color.
    const clear = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ portalBrandColor: '' });
    expect(clear.body.portalBrandColor).toBeNull();
    expect(clear.body.portalLogoUrl).toBe('https://cdn.example.com/logo.png'); // no tocado
  });

  it('rechaza un color no hexadecimal', async () => {
    const owner = await registerVerifiedUser(app, 'brandingx');
    const res = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ portalBrandColor: 'rojo' });
    expect(res.status).toBe(400);
  });
});
