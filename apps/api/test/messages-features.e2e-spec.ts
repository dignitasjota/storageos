import http from 'node:http';

import { hash } from '@node-rs/argon2';
import request from 'supertest';

import { SupportTicketsService } from '../src/modules/admin/support-tickets.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const ADMIN_EMAIL = 'messages-features-admin@e2e.local';
const ADMIN_PASSWORD = 'Secret-Admin-1';
const INBOUND_SECRET = 'email-inbound-secret-e2e';
const INBOUND_DOMAIN = 'r.trasteros.test';

describe('Mejoras de la mensajería (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaAdminService;
  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    process.env.INBOUND_EMAIL_DOMAIN = INBOUND_DOMAIN;
    await cleanupTestTenants();
    app = await createTestApp();
    prisma = app.get(PrismaAdminService);
    await prisma.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await prisma.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await hash(ADMIN_PASSWORD),
        fullName: 'Admin mejoras',
        role: 'superadmin',
        isActive: true,
      },
    });
    const login = await api()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await prisma.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await app.close();
    await cleanupTestTenants();
    delete process.env.INBOUND_EMAIL_DOMAIN;
  });

  const api = () => request(app.getHttpServer());

  async function portalLogin(slug: string, email: string) {
    await api().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await api().post('/portal/login/consume').send({ token });
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  async function upload(path: string, auth: Record<string, string>) {
    const presign = await api().post(path).set(auth).send({ mimeType: 'image/png' }).expect(200);
    await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body: PNG,
    });
    return { key: presign.body.key as string, mimeType: 'image/png', filename: 'foto.png' };
  }

  it('estado, responsable y notas internas de una conversación', async () => {
    const owner = await registerVerifiedUser(app, 'msgstate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `msg-state-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const pAuth = await portalLogin(owner.slug, email);

    await api().post('/portal/me/messages').set(pAuth).send({ body: 'Tengo una duda' });
    const inbox = async (q = '') =>
      (await api().get(`/customer-messages/inbox${q}`).set(auth).expect(200)).body;
    expect((await inbox()).items[0]).toMatchObject({ kind: 'customer', status: 'pending' });
    expect((await inbox()).counts.pending).toBe(1);

    // Quien la lleva y filtro «mías».
    await api()
      .patch(`/customers/${customerId}/messages/conversation`)
      .set(auth)
      .send({ assignedUserId: owner.userId })
      .expect(200);
    expect((await inbox('?mine=1')).items).toHaveLength(1);
    const ghost = await api()
      .patch(`/customers/${customerId}/messages/conversation`)
      .set(auth)
      .send({ assignedUserId: '00000000-0000-4000-8000-000000000000' });
    expect(ghost.status).toBe(400);

    // Una nota interna ni cuenta como respuesta ni la ve el inquilino.
    await api()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: 'Es el que debe dos meses', isInternal: true })
      .expect(201);
    expect((await inbox('?status=pending')).items).toHaveLength(1);
    const portal = await api().get('/portal/me/messages').set(pAuth).expect(200);
    expect((portal.body as { body: string }[]).map((m) => m.body)).toEqual(['Tengo una duda']);
    const unread = await api().get('/portal/me/messages/unread-count').set(pAuth).expect(200);
    expect(unread.body.count).toBe(0);

    // Responder la deja respondida; el inquilino la reabre; cerrarla la saca.
    await api().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Dime' });
    expect((await inbox('?status=answered')).items).toHaveLength(1);
    await api().post('/portal/me/messages').set(pAuth).send({ body: 'Gracias' });
    expect((await inbox('?status=pending')).items).toHaveLength(1);
    await api()
      .patch(`/customers/${customerId}/messages/conversation`)
      .set(auth)
      .send({ status: 'closed' })
      .expect(200);
    expect((await inbox('?status=pending')).items).toHaveLength(0);

    // El «visto» del inquilino y el contexto para escribir.
    const thread = await api().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    const seen = (thread.body as { body: string; readAt: string | null }[]).find(
      (m) => m.body === 'Dime',
    );
    expect(seen?.readAt).toBeNull();
    await api().get('/portal/me/messages').set(pAuth).expect(200);
    const after = await api().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    expect(
      (after.body as { body: string; readAt: string | null }[]).find((m) => m.body === 'Dime')
        ?.readAt,
    ).not.toBeNull();
  });

  it('búsqueda en todo el historial, aviso de que no le llega y escribir a varios', async () => {
    const owner = await registerVerifiedUser(app, 'msginbox');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const first = await createCustomer(app, owner.accessToken, {
      email: `msg-inbox-${Date.now()}@e2e.local`,
    });
    const created = await api()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Sin', lastName: 'Correo', country: 'ES' })
      .expect(201);
    const noEmail = created.body.id as string;

    const context = await api().get(`/customers/${noEmail}/messages/context`).set(auth).expect(200);
    expect(context.body.reach.unreachable).toBe(true);
    expect(context.body.variables.nombre).toBe('Sin');

    const res = await api()
      .post('/customer-messages/broadcast')
      .set(auth)
      .send({ customerIds: [first, noEmail], body: 'Mañana cortamos el agua de 10 a 12' })
      .expect(200);
    expect(res.body).toEqual({ sent: 2, skipped: 0 });

    await api().post(`/customers/${first}/messages`).set(auth).send({ body: 'Otra cosa' });
    const found = await api().get('/customer-messages/inbox?search=cortamos').set(auth).expect(200);
    expect((found.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual(
      [first, noEmail].sort(),
    );
    await api().get('/customer-messages/inbox?status=nada').set(auth).expect(400);
  });

  it('bandeja única con WhatsApp del negocio y chat de la web', async () => {
    const owner = await registerVerifiedUser(app, 'msgunified');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantPlan(owner.slug, 'pro');
    await prisma.tenantFeatureOverride.create({
      data: { tenantId: owner.tenantId, feature: 'whatsapp_business', enabled: true },
    });
    await prisma.whatsappConversation.create({
      data: {
        tenantId: owner.tenantId,
        waId: '34611000111',
        contactName: 'Lola',
        lastMessagePreview: 'Hola, ¿tenéis trasteros?',
        unreadCount: 2,
      },
    });
    await prisma.webChatConversation.create({
      data: { tenantId: owner.tenantId, visitorId: 'v1', mode: 'human', staffUnread: 1 },
    });
    await prisma.webChatConversation.create({
      data: { tenantId: owner.tenantId, visitorId: 'v2', mode: 'ai' },
    });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `msg-uni-${Date.now()}@e2e.local`,
    });
    await api().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Hola' });

    const inbox = await api().get('/customer-messages/inbox').set(auth).expect(200);
    expect((inbox.body.items as { kind: string }[]).map((i) => i.kind).sort()).toEqual([
      'customer',
      'web',
      'whatsapp',
    ]);
    const only = await api().get('/customer-messages/inbox?channel=whatsapp').set(auth).expect(200);
    expect(only.body.items).toHaveLength(1);
    expect(only.body.items[0]).toMatchObject({ name: 'Lola', unread: 2 });
  });

  it('respuestas guardadas, horario de atención y tiempos de respuesta', async () => {
    const owner = await registerVerifiedUser(app, 'msgauto');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `msg-auto-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const pAuth = await portalLogin(owner.slug, email);

    const canned = await api()
      .post('/customer-messages/canned')
      .set(auth)
      .send({ title: 'Saludo', body: 'Hola {nombre}, gracias por escribir a {negocio}' })
      .expect(201);
    const list = await api().get('/customer-messages/canned').set(auth).expect(200);
    expect(list.body).toHaveLength(1);
    await api()
      .delete(`/customer-messages/canned/${canned.body.id as string}`)
      .set(auth)
      .expect(204);

    const noHours = await api()
      .put('/customer-messages/settings')
      .set(auth)
      .send({ autoReplyEnabled: true });
    expect(noHours.status).toBe(400);
    // Sin ningún día abierto: siempre está fuera de horario.
    await api()
      .put('/customer-messages/settings')
      .set(auth)
      .send({ autoReplyEnabled: true, autoReply: 'Te contestamos el lunes', hours: {} })
      .expect(200);

    await api().post('/portal/me/messages').set(pAuth).send({ body: 'Hola' });
    await api().post('/portal/me/messages').set(pAuth).send({ body: '¿Hay alguien?' });
    const thread = await api().get('/portal/me/messages').set(pAuth).expect(200);
    const autos = (thread.body as { isAuto: boolean; body: string }[]).filter((m) => m.isAuto);
    expect(autos).toHaveLength(1);
    expect(autos[0]?.body).toBe('Te contestamos el lunes');

    // La respuesta automática no cuenta como respuesta del equipo.
    const inbox = await api().get('/customer-messages/inbox?status=pending').set(auth).expect(200);
    expect(inbox.body.items).toHaveLength(1);

    await prisma.customerMessage.updateMany({
      where: { customerId, senderType: 'customer' },
      data: { createdAt: new Date(Date.now() - 30 * 60_000) },
    });
    await api().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Dime' });
    const stats = await api().get('/customer-messages/stats?days=7').set(auth).expect(200);
    expect(stats.body.answered).toBe(1);
    expect(stats.body.medianMinutes).toBeGreaterThanOrEqual(29);
    expect(stats.body.byPerson[0].answered).toBe(1);
  });

  it('varios adjuntos y «Hoy» con las conversaciones sin contestar', async () => {
    const owner = await registerVerifiedUser(app, 'msgmulti');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `msg-multi-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const pAuth = await portalLogin(owner.slug, email);
    const path = `/customers/${customerId}/messages/upload-url`;
    const attachments = [await upload(path, auth), await upload(path, auth)];
    const sent = await api()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: 'Fotos', attachments })
      .expect(201);
    expect(sent.body.attachments).toHaveLength(2);

    await api().post('/portal/me/messages').set(pAuth).send({ body: 'Las veo' });
    const today = await api().get('/dashboard/today/extras').set(auth).expect(200);
    expect(
      (today.body.chatsWaiting.items as { refId: string }[]).some((i) => i.refId === customerId),
    ).toBe(true);
  });

  it('lo que se contesta al correo vuelve al hilo y al ticket', async () => {
    const owner = await registerVerifiedUser(app, 'msgreply');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `msg-reply-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });

    await api().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Hola' });
    await new Promise((r) => setTimeout(r, 500));
    const comm = await prisma.communication.findFirstOrThrow({
      where: { customerId, source: 'customer_email.staff_message' },
    });
    expect(comm.replyTo).toMatch(new RegExp(`^c-[a-f0-9]+@${INBOUND_DOMAIN}$`));

    // Aunque el remitente sea otro, la dirección manda; pero queda marcado.
    await api()
      .post('/webhooks/email-inbound')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({
        from: 'otra-persona@e2e.local',
        to: [`Trasteros <${comm.replyTo as string}>`],
        text: 'Contesto por correo\n\nEl lun, a las 10:12, Trasteros escribió:\n> Hola',
        dmarc: 'pass',
        attachments: [
          {
            filename: 'foto.png',
            contentType: 'image/png',
            contentBase64: PNG.toString('base64'),
          },
          { filename: 'virus.exe', contentType: 'application/x-msdownload', contentBase64: 'AAAA' },
        ],
      })
      .expect(200);
    const thread = await api().get(`/customers/${customerId}/messages`).set(auth).expect(200);
    const last = thread.body[thread.body.length - 1];
    expect(last).toMatchObject({
      body: 'Contesto por correo',
      channel: 'email',
      senderVerified: false,
    });
    expect(last.attachments).toHaveLength(1);

    // Ticket: la respuesta del admin se contesta por correo.
    const ticket = await api()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'No puedo facturar', body: 'Me da error', priority: 'normal' })
      .expect(201);
    const id = ticket.body.id as string;
    await api()
      .post(`/admin/support/tickets/${id}/messages`)
      .set(adminAuth)
      .send({ body: '¿Qué error?', isInternal: false })
      .expect(201);
    const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id } });
    expect(row.replyToken).toBeTruthy();
    const webhook = await api()
      .post('/webhooks/email-inbound')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({
        from: owner.email,
        to: `t-${row.replyToken as string}@${INBOUND_DOMAIN}`,
        text: 'El de la serie',
        dmarc: 'pass',
      })
      .expect(200);
    expect(webhook.body.received).toBe(true);
    const detail = await api().get(`/support/tickets/${id}`).set(auth).expect(200);
    expect(detail.body.status).toBe('open');
    expect(detail.body.messages[2].body).toBe('El de la serie');

    // Un desconocido no escribe en un ticket aunque tenga la dirección.
    const stranger = await api()
      .post('/webhooks/email-inbound')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({
        from: 'nadie@e2e.local',
        to: `t-${row.replyToken as string}@${INBOUND_DOMAIN}`,
        text: 'Hola',
      })
      .expect(200);
    expect(stranger.body.received).toBe(false);
  });

  it('tickets: cerrar, valorar, recordar y cerrar los que esperan', async () => {
    const owner = await registerVerifiedUser(app, 'msgrate');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const newTicket = async () => {
      const t = await api()
        .post('/support/tickets')
        .set(auth)
        .send({ subject: 'Una consulta', body: 'Hola', priority: 'normal' })
        .expect(201);
      return t.body.id as string;
    };

    const id = await newTicket();
    const early = await api().post(`/support/tickets/${id}/rating`).set(auth).send({ score: 5 });
    expect(early.status).toBe(400);
    await api().post(`/support/tickets/${id}/close`).set(auth).expect(200);
    const rated = await api()
      .post(`/support/tickets/${id}/rating`)
      .set(auth)
      .send({ score: 2, comment: 'Tardasteis' })
      .expect(200);
    expect(rated.body.rating).toBe(2);
    await api().post(`/support/tickets/${id}/rating`).set(auth).send({ score: 5 }).expect(409);
    const stats = await api().get('/admin/support/stats?days=7').set(adminAuth).expect(200);
    expect(stats.body.ratedTickets).toBeGreaterThanOrEqual(1);

    const waiting = await newTicket();
    await api()
      .post(`/admin/support/tickets/${waiting}/messages`)
      .set(adminAuth)
      .send({ body: '¿Nos das más datos?', isInternal: false })
      .expect(201);
    const tickets = app.get(SupportTicketsService);
    const day = 86_400_000;
    const old = (days: number) => new Date(Date.now() - days * day);
    await prisma.$executeRaw`UPDATE support_tickets SET updated_at = ${old(6)} WHERE id = ${waiting}::uuid`;
    expect((await tickets.remindWaiting()).reminded).toBeGreaterThanOrEqual(1);
    const again = await prisma.supportTicket.findUniqueOrThrow({ where: { id: waiting } });
    expect(again.status).toBe('waiting_user');
    expect(again.waitingRemindedAt).not.toBeNull();
    await prisma.$executeRaw`UPDATE support_tickets SET updated_at = ${old(11)} WHERE id = ${waiting}::uuid`;
    await tickets.remindWaiting();
    const closed = await prisma.supportTicket.findUniqueOrThrow({ where: { id: waiting } });
    expect(closed.status).toBe('closed');
  });

  it('el canal en vivo avisa a quien puede ver al inquilino', async () => {
    const owner = await registerVerifiedUser(app, 'msglive');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `msg-live-${Date.now()}@e2e.local`,
    });
    await signedContractFor(app, owner.accessToken, { id: customerId }, facility.facilityId);

    const { port } = (app.getHttpServer() as http.Server).address() as AddressInfo;
    const events: string[] = [];
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/realtime/stream',
        headers: { Authorization: `Bearer ${owner.accessToken}` },
      },
      (res) => res.on('data', (chunk: Buffer) => events.push(chunk.toString())),
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      await api().post(`/customers/${customerId}/messages`).set(auth).send({ body: 'Hola' });
      await new Promise((r) => setTimeout(r, 600));
      const text = events.join('');
      expect(text).toContain('"type":"customer_message"');
      expect(text).toContain(customerId);
      // Solo dice qué ha cambiado.
      expect(text).not.toContain('Hola');
      expect(text).not.toContain('facilityIds');
    } finally {
      req.destroy();
    }
  });
});
