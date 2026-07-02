import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const VERIFY_TOKEN = 'verify-token-e2e';
const EMAIL_SECRET = 'email-inbound-secret-e2e';

/**
 * Inbound de mensajes: respuestas del inquilino por WhatsApp/email que entran
 * al hilo de chat del cliente. El WABA/email es global → se resuelve el
 * customer por el remitente.
 */
describe('Inbound de mensajes (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Los secrets del inbound los fija `env-setup.ts` (el ConfigModule cachea).
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('verifica el webhook de WhatsApp (GET hub.challenge)', async () => {
    const ok = await request(app.getHttpServer()).get('/webhooks/whatsapp').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '123456',
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('123456');

    // Token incorrecto → 403.
    await request(app.getHttpServer())
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': 'x' })
      .expect(403);
  });

  it('un WhatsApp entrante del inquilino aparece en su chat', async () => {
    const owner = await registerVerifiedUser(app, 'inbound-wa');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Wasap',
      lastName: 'Cliente',
      phone: '+34600123456',
      country: 'ES',
    });
    const customerId = customer.body.id as string;

    // Meta postea con el teléfono del remitente (formato internacional sin +).
    const webhook = await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { from: '34600123456', type: 'text', text: { body: 'Hola, ¿está libre?' } },
                  ],
                },
              },
            ],
          },
        ],
      });
    expect(webhook.status).toBe(200);
    expect(webhook.body.received).toBe(true);

    // El staff ve el mensaje en el hilo del cliente, con canal whatsapp.
    const thread = await request(app.getHttpServer())
      .get(`/customers/${customerId}/messages`)
      .set(auth);
    expect(thread.status).toBe(200);
    expect(thread.body).toHaveLength(1);
    expect(thread.body[0]).toMatchObject({
      senderType: 'customer',
      channel: 'whatsapp',
      body: 'Hola, ¿está libre?',
    });
  });

  it('un email entrante (con secret) aparece en el chat; sin secret da 403', async () => {
    const owner = await registerVerifiedUser(app, 'inbound-email');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Mail',
      lastName: 'Cliente',
      email: 'mail-inbound@e2e.local',
      country: 'ES',
    });
    const customerId = customer.body.id as string;

    // Sin secret → 403.
    await request(app.getHttpServer())
      .post('/webhooks/email-inbound')
      .send({ from: 'mail-inbound@e2e.local', text: 'Respondo por correo' })
      .expect(403);

    // Con el secret correcto → registrado.
    const ok = await request(app.getHttpServer())
      .post('/webhooks/email-inbound')
      .set('X-Inbound-Secret', EMAIL_SECRET)
      .send({ from: 'MAIL-INBOUND@e2e.local', text: 'Respondo por correo' });
    expect(ok.status).toBe(200);
    expect(ok.body.received).toBe(true);

    const thread = await request(app.getHttpServer())
      .get(`/customers/${customerId}/messages`)
      .set(auth);
    expect(thread.body).toHaveLength(1);
    expect(thread.body[0]).toMatchObject({ senderType: 'customer', channel: 'email' });
  });
});
