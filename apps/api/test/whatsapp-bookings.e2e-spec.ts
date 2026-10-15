import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { BookingRecoveryService } from '../src/modules/move-in/booking-recovery.service';
import { WhatsappBookingRemindersService } from '../src/modules/whatsapp-business/whatsapp-booking-reminders.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * WhatsApp Business (PR 3) con IA y WhatsApp simulados: el asistente prepara
 * la reserva (enlace de firma y pago), plantillas fuera de las 24 h y el
 * recordatorio por WhatsApp de la reserva sin terminar.
 */
describe('Reservas por WhatsApp (e2e)', () => {
  let app: INestApplication;
  let prismaAdmin: PrismaAdminService;
  let adminAuth: { Authorization: string };
  const phoneNumberId = `4${Date.now()}`;
  let seq = 0;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prismaAdmin = app.get(PrismaAdminService);
    const admin = await seedSuperAdmin('wa-book');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
    await request(app.getHttpServer())
      .put('/admin/whatsapp-ai')
      .set(adminAuth)
      .send({
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: 'sk-ant-prueba-123456',
        monthlyReplyLimit: 100,
      })
      .expect(200);
  });

  afterAll(async () => {
    await request(app.getHttpServer())
      .put('/admin/whatsapp-ai')
      .set(adminAuth)
      .send({ enabled: false, monthlyReplyLimit: 300 });
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
  });

  function inbound(from: string, body: string, ts = Math.floor(Date.now() / 1000)) {
    seq += 1;
    return request(app.getHttpServer())
      .post('/webhooks/whatsapp')
      .send({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  contacts: [{ wa_id: from, profile: { name: 'Carlos Gómez' } }],
                  messages: [
                    {
                      id: `wamid.book-${Date.now()}-${seq}`,
                      from,
                      timestamp: String(ts),
                      type: 'text',
                      text: { body },
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      .expect(200);
  }

  async function waitFor<T>(fn: () => Promise<T | null | undefined>): Promise<T> {
    for (let i = 0; i < 50; i += 1) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout');
  }

  it('reserva desde el chat, plantilla fuera de 24 h y recordatorio por WhatsApp', async () => {
    const owner = await registerVerifiedUser(app, 'wa-book');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Norte',
      typeName: 'Mediano',
      unitsCount: 2,
      pricePerUnit: 50,
    });
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    const tenantId = (await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } }))
      .id;
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'EAAG-token-de-prueba-444444', enabled: true })
      .expect(200);
    const assistant = await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantEnabled: true });
    expect(assistant.body).toMatchObject({
      assistantBookingsEnabled: true,
      reminderTemplateName: null,
      reminderTemplateLanguage: 'es',
    });
    // Nombre de plantilla con mayúsculas → 400.
    await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ reminderTemplateName: 'Recordatorio Reserva' })
      .expect(400);

    // El cliente confirma: el asistente crea la reserva y envía el enlace.
    const start = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const data = {
      tipo: 'L1-T1',
      fecha: start,
      nombre: 'Carlos',
      apellidos: 'Gómez Ruiz',
      email: `carlos-${Date.now()}@example.com`,
      documento: '12345678Z',
    };
    await inbound('34677889900', `reservar ${JSON.stringify(data)}`);
    const reply = await waitFor(() =>
      prismaAdmin.whatsappMessage.findFirst({ where: { tenantId, sender: 'assistant' } }),
    );
    expect(reply.body).toContain('Mediano');
    expect(reply.body).toContain('/sign/');
    expect(reply.body).not.toContain('[[RESERVA');
    const conv = await prismaAdmin.whatsappConversation.findFirstOrThrow({
      where: { tenantId, waId: '34677889900' },
      include: { contract: { include: { customer: true } } },
    });
    expect(conv.contract).toMatchObject({ status: 'draft' });
    expect(conv.contract!.customer).toMatchObject({ firstName: 'Carlos', phone: '+34677889900' });
    // La conversación pasa a la ficha del nuevo inquilino.
    expect(conv.customerId).toBe(conv.contract!.customerId);
    expect(conv.assistantEnabled).toBe(true);
    expect(
      await prismaAdmin.notification.findFirst({ where: { tenantId, type: 'whatsapp.booking' } }),
    ).toBeTruthy();
    const list = await request(app.getHttpServer()).get('/whatsapp/conversations').set(auth);
    expect(list.body[0].contractId).toBe(conv.contractId);

    // Cliente que escribe en inglés: el aviso de IA sale en inglés y se guarda el idioma.
    await inbound('34655000777', 'Hello, how much is a storage unit?');
    const en = await waitFor(() =>
      prismaAdmin.whatsappMessage.findFirst({
        where: { tenantId, sender: 'assistant', conversation: { waId: '34655000777' } },
      }),
    );
    expect(en.body).toContain('You are chatting with an AI assistant');
    expect(en.body).not.toContain('[[IDIOMA');
    expect(
      await prismaAdmin.whatsappConversation.findFirst({
        where: { tenantId, waId: '34655000777' },
        select: { language: true },
      }),
    ).toEqual({ language: 'en' });
    expect(reply.body).toContain('Te responde un asistente automático');

    // Tamaño que no existe → no reserva, pasa a una persona.
    await inbound('34611000111', `reservar ${JSON.stringify({ ...data, tipo: 'L9-T9' })}`);
    const failed = await waitFor(() =>
      prismaAdmin.whatsappMessage.findFirst({
        where: { tenantId, sender: 'assistant', conversation: { waId: '34611000111' } },
      }),
    );
    expect(failed.body).toContain('No he podido completar la reserva');
    const failedConv = await prismaAdmin.whatsappConversation.findFirstOrThrow({
      where: { tenantId, waId: '34611000111' },
    });
    expect(failedConv).toMatchObject({ contractId: null, assistantEnabled: false });

    // Resumen del periodo.
    const stats = await request(app.getHttpServer())
      .get('/whatsapp/conversations/stats?days=30')
      .set(auth)
      .expect(200);
    expect(stats.body).toMatchObject({
      days: 30,
      conversations: 3,
      inboundMessages: 3,
      assistantReplies: 3,
      staffReplies: 0,
      handoffs: 1,
      bookings: 1,
      bookingsSigned: 0,
    });
    expect(stats.body.medianFirstResponseMinutes).not.toBeNull();

    // Recordatorio: reserva de hace 13 h con la ventana abierta → texto por WhatsApp.
    await prismaAdmin.contract.update({
      where: { id: conv.contractId! },
      data: { createdAt: new Date(Date.now() - 13 * 3600 * 1000) },
    });
    const reminders = app.get(WhatsappBookingRemindersService);
    expect(await reminders.sendDue()).toBe(1);
    const reminder = await prismaAdmin.whatsappMessage.findFirstOrThrow({
      where: { conversationId: conv.id, body: { contains: 'sigue reservado' } },
    });
    expect(reminder.body).toContain('/sign/');
    const contractAfter = await prismaAdmin.contract.findUniqueOrThrow({
      where: { id: conv.contractId! },
    });
    expect(contractAfter.bookingReminderSentAt).not.toBeNull();
    // No se repite, ni sale también por correo.
    expect(await reminders.sendDue()).toBe(0);
    await app.get(BookingRecoveryService).sendDueReminders();
    expect(
      await prismaAdmin.communication.count({
        where: { contractId: conv.contractId!, source: { startsWith: 'booking_recovery' } },
      }),
    ).toBe(0);

    // La reserva caduca sin firmar: el contacto puede volver a reservar por el chat.
    await prismaAdmin.contract.update({
      where: { id: conv.contractId! },
      data: { status: 'cancelled' },
    });
    await inbound(
      '34677889900',
      `reservar ${JSON.stringify({ ...data, email: `carlos2-${Date.now()}@example.com` })}`,
      // Meta da la hora en segundos: un segundo después para que no se junte con el primero.
      Math.floor(Date.now() / 1000) + 2,
    );
    const second = await waitFor(async () => {
      const c = await prismaAdmin.whatsappConversation.findUnique({ where: { id: conv.id } });
      return c?.contractId && c.contractId !== conv.contractId ? c : null;
    });
    expect(second.bookingReminderSentAt).toBeNull();

    // Tope diario por conversación: con 30 respuestas de la IA en 24 h pasa a una persona.
    await prismaAdmin.whatsappMessage.createMany({
      data: Array.from({ length: 30 }, () => ({
        tenantId,
        conversationId: conv.id,
        direction: 'out',
        sender: 'assistant',
        body: 'respuesta',
        status: 'sent',
        aiKeySource: 'platform',
      })),
    });
    const before = await prismaAdmin.whatsappMessage.count({ where: { conversationId: conv.id } });
    await inbound('34677889900', '¿Seguís ahí?', Math.floor(Date.now() / 1000) + 4);
    await waitFor(async () => {
      const c = await prismaAdmin.whatsappConversation.findUnique({ where: { id: conv.id } });
      return c && !c.assistantEnabled ? c : null;
    });
    // Solo el mensaje del cliente: el asistente no ha contestado.
    expect(await prismaAdmin.whatsappMessage.count({ where: { conversationId: conv.id } })).toBe(
      before + 1,
    );

    // Plantilla fuera de las 24 h desde la bandeja.
    await prismaAdmin.whatsappConversation.update({
      where: { id: failedConv.id },
      data: { lastInboundAt: new Date(Date.now() - 2 * 86400000) },
    });
    const tpl = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${failedConv.id}/template`)
      .set(auth)
      .send({ name: 'seguimiento_contacto', language: 'es', params: ['Carlos'] });
    expect(tpl.status).toBe(201);
    expect(tpl.body).toMatchObject({ status: 'sent', sender: 'staff' });
    expect(tpl.body.body).toContain('seguimiento_contacto');
    const badTpl = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${failedConv.id}/template`)
      .set(auth)
      .send({ name: 'invalid_tpl', language: 'es', params: [] });
    expect(badTpl.status).toBe(502);
  });

  it('sin ventana abierta ni plantilla, el recordatorio se deja para el correo', async () => {
    const owner = await registerVerifiedUser(app, 'wa-book2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1, pricePerUnit: 40 });
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    const tenantId = (await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } }))
      .id;
    const otherPhoneId = `5${Date.now()}`;
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({
        phoneNumberId: otherPhoneId,
        accessToken: 'EAAG-token-de-prueba-333333',
        enabled: true,
      })
      .expect(200);
    await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantEnabled: true })
      .expect(200);

    const start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
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
                      id: `wamid.book2-${Date.now()}`,
                      from: '34622000999',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: {
                        body: `reservar ${JSON.stringify({
                          tipo: 'L1-T1',
                          fecha: start,
                          nombre: 'Lucía',
                          apellidos: 'Martín',
                          email: `lucia-${Date.now()}@example.com`,
                          documento: 'X1234567L',
                        })}`,
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
      .expect(200);
    const conv = await waitFor(() =>
      prismaAdmin.whatsappConversation.findFirst({
        where: { tenantId, contractId: { not: null } },
      }),
    );
    // Reserva de hace 13 h y la ventana de 24 h cerrada, sin plantilla.
    await prismaAdmin.contract.update({
      where: { id: conv.contractId! },
      data: { createdAt: new Date(Date.now() - 13 * 3600 * 1000) },
    });
    await prismaAdmin.whatsappConversation.update({
      where: { id: conv.id },
      data: { lastInboundAt: new Date(Date.now() - 2 * 86400000) },
    });
    expect(await app.get(WhatsappBookingRemindersService).sendDue()).toBe(0);
    const after = await prismaAdmin.contract.findUniqueOrThrow({ where: { id: conv.contractId! } });
    expect(after.bookingReminderSentAt).toBeNull();
    // Ahora sí lo manda el correo.
    await app.get(BookingRecoveryService).sendDueReminders();
    expect(
      await prismaAdmin.communication.count({
        where: { contractId: conv.contractId!, source: 'booking_recovery.unsigned' },
      }),
    ).toBe(1);
  });
});
