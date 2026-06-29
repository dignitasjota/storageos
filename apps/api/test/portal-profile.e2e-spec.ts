import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal — editar perfil (e2e)', () => {
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

  async function portalLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('el inquilino ve y actualiza sus datos (no el email)', async () => {
    const owner = await registerVerifiedUser(app, 'profile');
    const email = `profile-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Lee el perfil.
    const get = await request(app.getHttpServer()).get('/portal/me/profile').set(pAuth);
    expect(get.status).toBe(200);
    expect(get.body.email).toBe(email);
    expect(get.body).toHaveProperty('customerType');

    // Actualiza contacto + datos fiscales.
    const patch = await request(app.getHttpServer()).patch('/portal/me/profile').set(pAuth).send({
      phone: '600111222',
      address: 'Calle Mayor 1',
      city: 'Madrid',
      postalCode: '28001',
      country: 'es',
      documentType: 'NIF',
      documentNumber: '12345678Z',
    });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({
      phone: '600111222',
      address: 'Calle Mayor 1',
      city: 'Madrid',
      postalCode: '28001',
      country: 'ES', // normalizado a mayúsculas
      documentNumber: '12345678Z',
      email, // el email no cambia
    });

    // Persiste + '' borra un campo.
    const patch2 = await request(app.getHttpServer())
      .patch('/portal/me/profile')
      .set(pAuth)
      .send({ phone: '' });
    expect(patch2.body.phone).toBeNull();
    expect(patch2.body.address).toBe('Calle Mayor 1'); // no se tocó
  });

  it('exige sesión de portal', async () => {
    const r = await request(app.getHttpServer()).get('/portal/me/profile');
    expect(r.status).toBe(401);
  });
});
