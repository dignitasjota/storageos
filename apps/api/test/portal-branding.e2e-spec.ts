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
    expect(initial.body).toMatchObject({ portalBrandColor: null, portalLogoUrl: null });

    // Configurar. IP pública literal (93.184.216.34 = example.com) para no
    // depender de resolución DNS real en el test — mismo patrón que
    // `external-site.e2e-spec.ts` para la misma guarda SSRF compartida.
    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ portalBrandColor: '#ff6600', portalLogoUrl: 'https://93.184.216.34/logo.png' });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({
      portalBrandColor: '#ff6600',
      portalLogoUrl: 'https://93.184.216.34/logo.png',
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
    expect(consume.body.logoUrl).toBe('https://93.184.216.34/logo.png');

    // '' borra el color.
    const clear = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ portalBrandColor: '' });
    expect(clear.body.portalBrandColor).toBeNull();
    expect(clear.body.portalLogoUrl).toBe('https://93.184.216.34/logo.png'); // no tocado
  });

  it('rechaza un color no hexadecimal', async () => {
    const owner = await registerVerifiedUser(app, 'brandingx');
    const res = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send({ portalBrandColor: 'rojo' });
    expect(res.status).toBe(400);
  });

  it(
    'rechaza portalLogoUrl apuntando a una IP privada/loopback (SSRF: el logo lo ' +
      'fetchea el servidor al generar la imagen Open Graph del tenant, no solo el navegador)',
    async () => {
      const owner = await registerVerifiedUser(app, 'brandingssrf');
      const auth = { Authorization: `Bearer ${owner.accessToken}` };

      for (const bad of ['https://127.0.0.1/logo.png', 'https://10.0.0.5/logo.png']) {
        const res = await request(app.getHttpServer())
          .patch('/settings/tenant/branding')
          .set(auth)
          .send({ portalLogoUrl: bad });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('portal_logo_url_invalid');
      }

      // http:// (sin TLS) tampoco se acepta.
      const notHttps = await request(app.getHttpServer())
        .patch('/settings/tenant/branding')
        .set(auth)
        .send({ portalLogoUrl: 'http://93.184.216.34/logo.png' });
      expect(notHttps.status).toBe(400);
      expect(notHttps.body.code).toBe('portal_logo_url_invalid');

      // El branding no quedó modificado por ninguno de los intentos fallidos.
      const after = await request(app.getHttpServer()).get('/settings/tenant/branding').set(auth);
      expect(after.body.portalLogoUrl).toBeNull();
    },
  );
});
