import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { InboundMessagesService } from '../src/modules/inbound-messages/inbound-messages.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Chat: la respuesta sale por el canal por el que escribió el inquilino (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  async function waitForComm(prisma: PrismaAdminService, customerId: string, source: string) {
    for (let i = 0; i < 50; i++) {
      const row = await prisma.communication.findFirst({ where: { customerId, source } });
      if (row) return row;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  it('WhatsApp en las últimas 24 h → responde por WhatsApp; email → responde por email aunque las copias estén apagadas', async () => {
    const owner = await registerVerifiedUser(app, 'chatreply');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const prisma = app.get(PrismaAdminService);
    const inbound = app.get(InboundMessagesService);
    const stamp = Date.now();
    const phone = `+3467${String(stamp).slice(-7)}`;
    const email = `chatreply-${stamp}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    await prisma.customer.update({ where: { id: customerId }, data: { phone } });

    // Escribe por WhatsApp y el equipo responde.
    expect(
      await inbound.record({ channel: 'whatsapp', from: phone, body: '¿Abrís el sábado?' }),
    ).toBe(true);
    await http()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: 'Sí, de 9 a 14.' });
    const wa = await waitForComm(prisma, customerId, 'customer_message.reply');
    expect(wa?.channel).toBe('whatsapp');
    expect(wa?.bodyText).toBe('Sí, de 9 a 14.');

    // Con las copias por correo apagadas, quien escribe por email recibe la respuesta por email.
    await http()
      .patch('/settings/tenant/customer-emails')
      .set(auth)
      .send({ staff_message: false })
      .expect(200);
    await prisma.customerMessage.updateMany({
      where: { customerId },
      data: { createdAt: new Date(Date.now() - 3600 * 1000) },
    });
    expect(await inbound.record({ channel: 'email', from: email, body: 'Otra duda' })).toBe(true);
    await http().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Dime.' });
    const mail = await waitForComm(prisma, customerId, 'customer_email.staff_message');
    expect(mail?.channel).toBe('email');
  });
});
