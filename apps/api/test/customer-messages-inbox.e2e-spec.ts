import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Bandeja «Mensajes» con leído por usuario (e2e)', () => {
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

  const http = () => request(app.getHttpServer());

  async function portalLogin(slug: string, email: string): Promise<string> {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await http().post('/portal/login/consume').send({ token });
    return consume.body.accessToken as string;
  }

  it('lista las conversaciones por último mensaje y cada usuario lleva su propio leído', async () => {
    const owner = await registerVerifiedUser(app, 'inbox');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };

    // Un segundo usuario del equipo.
    const staffEmail = `inbox-staff-${Date.now()}@e2e.local`;
    await http()
      .post('/invitations')
      .set(ownerAuth)
      .send({ email: staffEmail, role: 'staff' })
      .expect(201);
    const invite = await waitForEmail(staffEmail, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(invite.Text, '/invite')}/accept`)
      .send({ fullName: 'Staff Bandeja', password: 'Passw0rd!' })
      .expect(200);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: staffEmail, password: 'Passw0rd!' });
    const staffAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // Dos inquilinos escriben; el segundo, después.
    const emailA = `inbox-a-${Date.now()}@e2e.local`;
    const emailB = `inbox-b-${Date.now()}@e2e.local`;
    const a = await createCustomer(app, owner.accessToken, { email: emailA });
    const b = await createCustomer(app, owner.accessToken, { email: emailB });
    const pA = { Authorization: `Bearer ${await portalLogin(owner.slug, emailA)}` };
    const pB = { Authorization: `Bearer ${await portalLogin(owner.slug, emailB)}` };
    await http().post('/portal/me/messages').set(pA).send({ body: 'Hola desde A' }).expect(201);
    await new Promise((r) => setTimeout(r, 20));
    await http().post('/portal/me/messages').set(pB).send({ body: 'Hola desde B' }).expect(201);

    const inbox = await http().get('/customer-messages/conversations').set(ownerAuth).expect(200);
    expect(inbox.body.map((c: { customerId: string }) => c.customerId)).toEqual([b, a]);
    expect(inbox.body[0]).toMatchObject({ unread: 1, lastMessage: { body: 'Hola desde B' } });

    // El propietario abre la conversación de A: a él se le apaga, al otro usuario no.
    await http().get(`/customers/${a}/messages`).set(ownerAuth).expect(200);
    const ownerSummary = await http().get('/customer-messages/unread-summary').set(ownerAuth);
    expect(ownerSummary.body.byCustomer[a] ?? 0).toBe(0);
    expect(ownerSummary.body.byCustomer[b]).toBe(1);
    const staffSummary = await http().get('/customer-messages/unread-summary').set(staffAuth);
    expect(staffSummary.body.byCustomer[a]).toBe(1);
    expect(staffSummary.body.total).toBe(2);

    // Filtro por un local en el que no tienen contrato → nada.
    const none = await http()
      .get('/customer-messages/conversations?facilityId=00000000-0000-7000-8000-000000000000')
      .set(ownerAuth)
      .expect(200);
    expect(none.body).toEqual([]);
  });
});
