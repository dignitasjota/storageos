import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Chat: avisos por correo y sin repetir (e2e)', () => {
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
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function portalLogin(slug: string, email: string): Promise<string> {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await http().post('/portal/login/consume').send({ token });
    return consume.body.accessToken as string;
  }

  it('el inquilino y el equipo reciben un solo aviso por tanda de mensajes', async () => {
    const owner = await registerVerifiedUser(app, 'chatnotice');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `chatnotice-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const prisma = app.get(PrismaAdminService);
    const pAuth = { Authorization: `Bearer ${await portalLogin(owner.slug, email)}` };

    // El equipo escribe dos veces seguidas → un solo correo al inquilino.
    await http().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Hola Ana' });
    await http()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: 'Te esperamos el lunes' });
    const mail = await waitForEmail(email, { subjectIncludes: 'Tienes un mensaje de' });
    expect(mail.Text).toContain('Hola Ana');
    await pause(1500);
    const copies = await prisma.communication.count({
      where: { customerId, source: 'customer_email.staff_message' },
    });
    expect(copies).toBe(1);

    // El inquilino escribe dos veces sin que nadie lo lea → una notificación y un correo.
    await http().post('/portal/me/messages').set(pAuth).send({ body: '¿Puedo ir el martes?' });
    await http().post('/portal/me/messages').set(pAuth).send({ body: 'O el miércoles' });
    const staffMail = await waitForEmail(owner.email, { subjectIncludes: 'Mensaje de' });
    expect(staffMail.Text).toContain('¿Puedo ir el martes?');
    const notifs = await prisma.notification.count({
      where: { tenantId: owner.tenantId, type: 'customer.message' },
    });
    expect(notifs).toBe(1);

    // Tras leerlo el equipo, un mensaje nuevo vuelve a avisar.
    await http().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    await http().post('/portal/me/messages').set(pAuth).send({ body: 'Gracias' });
    const again = await prisma.notification.count({
      where: { tenantId: owner.tenantId, type: 'customer.message' },
    });
    expect(again).toBe(2);
  });
});
