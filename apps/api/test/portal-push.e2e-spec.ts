import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal: notificaciones push (e2e)', () => {
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

  it('suscribe y cancela la suscripción push del inquilino', async () => {
    const owner = await registerVerifiedUser(app, 'ppush');
    const email = `ppush-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Sin token → 401.
    await request(app.getHttpServer()).get('/portal/me/push/public-key').expect(401);

    // Sin VAPID configurado en test → publicKey null (el front no mostraría el botón).
    const key = await request(app.getHttpServer()).get('/portal/me/push/public-key').set(pAuth);
    expect(key.status).toBe(200);
    expect(key.body.publicKey).toBeNull();

    const sub = {
      endpoint: 'https://push.example.com/sub/abc123',
      keys: { p256dh: 'BPp256dhKEY', auth: 'AUTHKEY' },
    };
    // Suscribir (idempotente).
    await request(app.getHttpServer())
      .post('/portal/me/push/subscribe')
      .set(pAuth)
      .send(sub)
      .expect(204);
    await request(app.getHttpServer())
      .post('/portal/me/push/subscribe')
      .set(pAuth)
      .send(sub)
      .expect(204);

    // Cancelar.
    await request(app.getHttpServer())
      .post('/portal/me/push/unsubscribe')
      .set(pAuth)
      .send({ endpoint: sub.endpoint })
      .expect(204);

    // Endpoint inválido → 400.
    await request(app.getHttpServer())
      .post('/portal/me/push/subscribe')
      .set(pAuth)
      .send({ endpoint: 'not-a-url', keys: { p256dh: 'x', auth: 'y' } })
      .expect(400);
  });
});
