import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Chat bidireccional inquilino <-> staff (e2e)', () => {
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

  it('el inquilino escribe, el staff lo ve y responde, y el inquilino recibe la respuesta', async () => {
    const owner = await registerVerifiedUser(app, 'chat');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `chat-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // El inquilino escribe.
    const sent = await request(app.getHttpServer())
      .post('/portal/me/messages')
      .set(pAuth)
      .send({ body: 'Hola, ¿puedo ampliar mi trastero?' });
    expect(sent.status).toBe(201);
    expect(sent.body.senderType).toBe('customer');
    expect(sent.body.senderName).toBeNull();

    // El badge: hay 1 mensaje sin leer para este customer.
    const before = await request(app.getHttpServer())
      .get('/customer-messages/unread-summary')
      .set(auth);
    expect(before.status).toBe(200);
    expect(before.body.total).toBeGreaterThanOrEqual(1);
    expect(before.body.byCustomer[customerId]).toBe(1);

    // El staff ve el mensaje (al listar se marcan leídos).
    const staffList = await request(app.getHttpServer())
      .get(`/customers/${customerId}/messages`)
      .set(auth);
    expect(staffList.status).toBe(200);
    expect(staffList.body).toHaveLength(1);
    expect(staffList.body[0].body).toContain('ampliar mi trastero');

    // Tras abrir el chat, el customer ya no tiene mensajes sin leer.
    const after = await request(app.getHttpServer())
      .get('/customer-messages/unread-summary')
      .set(auth);
    expect(after.body.byCustomer[customerId] ?? 0).toBe(0);

    // El staff responde.
    const reply = await request(app.getHttpServer())
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: 'Claro, te paso opciones.' });
    expect(reply.status).toBe(201);
    expect(reply.body.senderType).toBe('staff');
    expect(reply.body.senderName).toBeTruthy();

    // Badge del portal del inquilino: 1 mensaje del staff sin leer.
    const portalBefore = await request(app.getHttpServer())
      .get('/portal/me/messages/unread-count')
      .set(pAuth);
    expect(portalBefore.status).toBe(200);
    expect(portalBefore.body.count).toBe(1);

    // El inquilino ve ambos mensajes; el del staff queda marcado leído al listar.
    const portalList = await request(app.getHttpServer()).get('/portal/me/messages').set(pAuth);
    expect(portalList.body).toHaveLength(2);
    const staffMsg = portalList.body.find((m: { senderType: string }) => m.senderType === 'staff');
    expect(staffMsg.readAt).toBeTruthy();

    // Tras leerlos, el badge del portal vuelve a 0.
    const portalAfter = await request(app.getHttpServer())
      .get('/portal/me/messages/unread-count')
      .set(pAuth);
    expect(portalAfter.body.count).toBe(0);
  });

  it('exige sesión de portal / permiso de staff', async () => {
    const portal = await request(app.getHttpServer()).get('/portal/me/messages');
    expect(portal.status).toBe(401);
    const staff = await request(app.getHttpServer()).get(
      '/customers/00000000-0000-0000-0000-000000000000/messages',
    );
    expect(staff.status).toBe(401);
  });
});
