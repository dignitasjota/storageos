import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Extra «WhatsApp Business» con WhatsApp simulado (`NODE_ENV=test`): número del
 * tenant, mensajes que entran por el webhook asignados por `phone_number_id`,
 * contacto nuevo como lead, bandeja y respuesta del equipo.
 */
describe('WhatsApp Business (e2e)', () => {
  let app: INestApplication;
  let prismaAdmin: PrismaAdminService;
  const phoneNumberId = `1${Date.now()}`;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prismaAdmin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  function inbound(args: { from: string; id: string; body: string; name?: string; ts?: number }) {
    return request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  contacts: [{ wa_id: args.from, profile: { name: args.name ?? 'Laura Pérez' } }],
                  messages: [
                    {
                      id: args.id,
                      from: args.from,
                      timestamp: String(args.ts ?? Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: args.body },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
  }

  it('configura el número, recibe un contacto nuevo y responde desde el panel', async () => {
    const owner = await registerVerifiedUser(app, 'wa-biz');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Sin el extra → 403.
    await request(app.getHttpServer()).get('/settings/whatsapp').set(auth).expect(403);
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);

    const empty = await request(app.getHttpServer()).get('/settings/whatsapp').set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.configured).toBe(false);

    // Token rechazado por WhatsApp (simulado) → 400.
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'invalid-token-0123456789', enabled: true })
      .expect(400);

    const saved = await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'EAAG-token-de-prueba-123456', enabled: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      enabled: true,
      displayPhone: '+34 600 000 000',
      tokenLast4: '3456',
    });
    expect(JSON.stringify(saved.body)).not.toContain('EAAG-token');

    // La web pública lleva el botón con el número.
    const landing = await request(app.getHttpServer()).get(`/public/landing/${owner.slug}`);
    expect(landing.body.whatsappNumber).toBe('34600000000');

    // Un desconocido escribe → conversación + lead de WhatsApp.
    const wamid = `wamid.in-${Date.now()}`;
    await inbound({
      from: '34611222333',
      id: wamid,
      body: 'Hola, ¿tenéis trasteros de 5 m²?',
    }).expect(200);
    // Reentrega del mismo mensaje: no se duplica.
    await inbound({
      from: '34611222333',
      id: wamid,
      body: 'Hola, ¿tenéis trasteros de 5 m²?',
    }).expect(200);

    const list = await request(app.getHttpServer()).get('/whatsapp/conversations').set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const conv = list.body[0];
    expect(conv).toMatchObject({
      waId: '34611222333',
      contactName: 'Laura Pérez',
      unreadCount: 1,
      canReply: true,
      customerId: null,
    });
    expect(conv.leadId).toBeTruthy();
    const lead = await prismaAdmin.lead.findUnique({ where: { id: conv.leadId } });
    expect(lead).toMatchObject({ source: 'whatsapp', firstName: 'Laura', phone: '+34611222333' });

    const unread = await request(app.getHttpServer())
      .get('/whatsapp/conversations/unread-count')
      .set(auth);
    expect(unread.body.count).toBe(1);

    // Abrir la conversación la marca como leída.
    const detail = await request(app.getHttpServer())
      .get(`/whatsapp/conversations/${conv.id}`)
      .set(auth);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0]).toMatchObject({ direction: 'in', sender: 'contact' });
    const after = await request(app.getHttpServer())
      .get('/whatsapp/conversations/unread-count')
      .set(auth);
    expect(after.body.count).toBe(0);

    // Respuesta del equipo (enviada por el WhatsApp simulado).
    const reply = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${conv.id}/messages`)
      .set(auth)
      .send({ body: 'Sí, nos quedan dos. ¿Para cuándo lo necesitas?' });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ direction: 'out', sender: 'staff', status: 'sent' });

    // Aviso de entrega de Meta → «read».
    const out = await prismaAdmin.whatsappMessage.findFirstOrThrow({
      where: { conversationId: conv.id, direction: 'out' },
    });
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  statuses: [{ id: out.waMessageId, status: 'read' }],
                },
              },
            ],
          },
        ],
      })
      .expect(200);
    const read = await prismaAdmin.whatsappMessage.findUniqueOrThrow({ where: { id: out.id } });
    expect(read.status).toBe('read');
  });

  it('un inquilino conocido se enlaza a su ficha y fuera de 24 h no se puede responder', async () => {
    const owner = await registerVerifiedUser(app, 'wa-biz2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    const otherPhoneId = `2${Date.now()}`;
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({
        phoneNumberId: otherPhoneId,
        accessToken: 'EAAG-token-de-prueba-999999',
        enabled: true,
      })
      .expect(200);

    // El mismo número no puede estar en dos cuentas.
    const intruder = await registerVerifiedUser(app, 'wa-biz3');
    await setTenantFeatureOverride(intruder.slug, 'whatsapp_business', true);
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set({ Authorization: `Bearer ${intruder.accessToken}` })
      .send({
        phoneNumberId: otherPhoneId,
        accessToken: 'EAAG-token-de-prueba-777777',
        enabled: true,
      })
      .expect(409);

    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Pedro',
      lastName: 'Inquilino',
      phone: '622 33 44 55',
      country: 'ES',
    });
    expect(customer.status).toBe(201);

    // Mensaje de hace dos días (ventana de 24 h cerrada).
    const old = Math.floor(Date.now() / 1000) - 2 * 24 * 3600;
    await request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: otherPhoneId },
                  messages: [
                    {
                      id: `wamid.old-${Date.now()}`,
                      from: '34622334455',
                      timestamp: String(old),
                      type: 'text',
                      text: { body: '¿Hasta qué hora se puede entrar?' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      .expect(200);

    const list = await request(app.getHttpServer()).get('/whatsapp/conversations').set(auth);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      customerId: customer.body.id,
      customerName: 'Pedro Inquilino',
      leadId: null,
      canReply: false,
    });

    const reply = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${list.body[0].id}/messages`)
      .set(auth)
      .send({ body: 'Hasta las 22:00' });
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('whatsapp_window_closed');

    // El otro tenant no ve la conversación.
    const foreign = await request(app.getHttpServer())
      .get(`/whatsapp/conversations/${list.body[0].id}`)
      .set({ Authorization: `Bearer ${intruder.accessToken}` });
    expect(foreign.status).toBe(404);
  });
});
