import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Centro de ayuda / FAQ (e2e)', () => {
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

  it('el staff gestiona el FAQ y el inquilino ve solo las publicadas', async () => {
    const owner = await registerVerifiedUser(app, 'faq');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `faq-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    // Crear: una publicada + una oculta.
    const pub = await request(app.getHttpServer())
      .post('/faq-entries')
      .set(auth)
      .send({ question: '¿Cómo accedo?', answer: 'Con tu PIN/QR.', position: 0 });
    expect(pub.status).toBe(201);
    expect(pub.body.isPublished).toBe(true);

    const hidden = await request(app.getHttpServer())
      .post('/faq-entries')
      .set(auth)
      .send({ question: 'Borrador', answer: 'No publicado.', isPublished: false, position: 1 });
    const hiddenId = hidden.body.id as string;

    // El staff ve ambas.
    const staffList = await request(app.getHttpServer()).get('/faq-entries').set(auth);
    expect(staffList.body).toHaveLength(2);

    // El inquilino solo ve la publicada.
    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };
    const portalList = await request(app.getHttpServer()).get('/portal/me/faq').set(pAuth);
    expect(portalList.status).toBe(200);
    expect(portalList.body).toHaveLength(1);
    expect(portalList.body[0].question).toBe('¿Cómo accedo?');

    // Publicar la oculta → el inquilino ya ve 2.
    await request(app.getHttpServer())
      .patch(`/faq-entries/${hiddenId}`)
      .set(auth)
      .send({ isPublished: true })
      .expect(200);
    const portalList2 = await request(app.getHttpServer()).get('/portal/me/faq').set(pAuth);
    expect(portalList2.body).toHaveLength(2);

    // Borrar.
    await request(app.getHttpServer()).delete(`/faq-entries/${hiddenId}`).set(auth).expect(204);
    const portalList3 = await request(app.getHttpServer()).get('/portal/me/faq').set(pAuth);
    expect(portalList3.body).toHaveLength(1);
  });

  it('exige sesión/permiso', async () => {
    const portal = await request(app.getHttpServer()).get('/portal/me/faq');
    expect(portal.status).toBe(401);
    const staff = await request(app.getHttpServer()).get('/faq-entries');
    expect(staff.status).toBe(401);
  });
});
