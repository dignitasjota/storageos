import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformAiSettingsService } from '../src/modules/ai/platform-ai-settings.service';
import { DataRetentionService } from '../src/modules/data-retention/data-retention.service';
import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Revisión del chat de la web: permisos, avisos, privacidad, horario y origen. */
describe('Chat de la web: revisión (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());
  const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const chat = (slug: string, body: Record<string, unknown>) =>
    http().post(`/public/landing/${slug}/chat`).set('User-Agent', UA).send(body);
  const visitor = () => `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** Usuario del equipo con un rol a medida (solo esos permisos). */
  async function userWithPermissions(
    owner: { slug: string; accessToken: string },
    tag: string,
    permissions: string[],
  ): Promise<{ id: string; auth: { Authorization: string } }> {
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `${tag}-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await http().post('/invitations').set(ownerAuth).send({ email, role: 'staff' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: `Rol ${tag}`, password })
      .expect(200);
    const users = await http().get('/users').set(ownerAuth).expect(200);
    const user = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    const role = await http()
      .post('/settings/roles')
      .set(ownerAuth)
      .send({ name: `Rol ${tag}`, permissions, baseRole: 'staff' })
      .expect(201);
    await http()
      .patch(`/settings/users/${user.id}/tenant-role`)
      .set(ownerAuth)
      .send({ tenantRoleId: role.body.id })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password })
      .expect(200);
    return { id: user.id, auth: { Authorization: `Bearer ${login.body.accessToken as string}` } };
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    await db.platformAiSettings.updateMany({ data: { webVisitorDailyLimit: 15 } });
    await app.get(PlatformAiSettingsService).refresh();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('un mismo permiso para leer el chat y sus avisos; leído solo al responder', async () => {
    const owner = await registerVerifiedUser(app, 'wcperm');
    await setTenantPlan(owner.slug, 'pro');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const reader = await userWithPermissions(owner, 'wcread', [
      'communications:read',
      'communications:send',
    ]);
    const marketer = await userWithPermissions(owner, 'wcmkt', ['marketing:read']);

    const v = visitor();
    await chat(owner.slug, { visitorId: v, message: '¿Tenéis trasteros grandes?' }).expect(200);
    await chat(owner.slug, { visitorId: v, message: 'Quiero hablar con una persona' }).expect(200);
    await chat(owner.slug, { visitorId: v, message: '¿Hay alguien?' }).expect(200);
    await new Promise((r) => setTimeout(r, 300));

    // Los avisos llegan a quien puede leer las conversaciones, no al de marketing.
    const notified = await db.notification.findMany({
      where: { tenantId: owner.tenantId, type: { startsWith: 'web_chat.' } },
      select: { userId: true },
    });
    const users = new Set(notified.map((n) => n.userId));
    expect(users.has(reader.id)).toBe(true);
    expect(users.has(marketer.id)).toBe(false);

    // Conversaciones: comunicaciones. Cifras: marketing.
    await http().get('/web-chat/conversations/page').set(marketer.auth).expect(403);
    await http().get('/web-chat/stats').set(reader.auth).expect(403);
    await http().get('/web-chat/stats').set(marketer.auth).expect(200);
    const list = await http().get('/web-chat/conversations/page').set(reader.auth).expect(200);
    const conv = list.body.items[0];
    // La petición de una persona y el mensaje siguiente.
    expect(conv.staffUnread).toBe(2);
    const pending = await http().get('/web-chat/pending').set(reader.auth).expect(200);
    expect(pending.body).toMatchObject({ waiting: 1, unread: 2, conversations: 1 });

    // Abrirla no la da por leída; marcarla (quien puede responder) sí.
    await http().get(`/web-chat/conversations/${conv.id}`).set(reader.auth).expect(200);
    const info = await http()
      .get(`/web-chat/conversations/${conv.id}/info`)
      .set(reader.auth)
      .expect(200);
    expect(info.body).toMatchObject({ id: conv.id, staffUnread: 2, mode: 'human' });
    await http().post(`/web-chat/conversations/${conv.id}/read`).set(reader.auth).expect(204);
    const after = await http()
      .get(`/web-chat/conversations/${conv.id}/info`)
      .set(ownerAuth)
      .expect(200);
    expect(after.body.staffUnread).toBe(0);

    // Borrarla: marketing:manage (el propietario).
    await http().delete(`/web-chat/conversations/${conv.id}`).set(reader.auth).expect(403);
    await http().delete(`/web-chat/conversations/${conv.id}`).set(ownerAuth).expect(204);
    await http().get(`/web-chat/conversations/${conv.id}/info`).set(ownerAuth).expect(404);
  });

  it('el visitante ve solo lo reciente, sin el DNI ni el enlace de firma, y la reserva lleva su origen', async () => {
    const owner = await registerVerifiedUser(app, 'wcpriv');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Privado',
      typeName: 'Pequeño',
      unitsCount: 2,
      pricePerUnit: 40,
    });
    const start = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);

    const v = visitor();
    const booked = await chat(owner.slug, {
      visitorId: v,
      message: `reservar ${JSON.stringify({
        tipo: 'L1-T1',
        fecha: start,
        nombre: 'Rosa',
        apellidos: 'Gil',
        email: 'rosa-wc@e2e.local',
        telefono: '600222333',
        documento: '12345678Z',
      })}`,
      utmSource: 'instagram',
      utmMedium: 'paid_social',
      utmCampaign: 'otono',
    }).expect(200);
    // El visitante recibe el enlace en la respuesta…
    expect(booked.body.answer).toContain('/sign/');

    // …pero no se guarda, y su DNI sale tapado al volver a cargar el chat.
    const conv = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: v },
    });
    expect(conv).toMatchObject({ utmSource: 'instagram', utmMedium: 'paid_social' });
    const stored = await db.webChatMessage.findMany({ where: { conversationId: conv.id } });
    expect(stored.some((m) => m.content.includes('/sign/'))).toBe(false);
    const history = await http()
      .post(`/public/landing/${owner.slug}/chat/history`)
      .send({ visitorId: v })
      .expect(200);
    const text = history.body.messages.map((m: { content: string }) => m.content).join('\n');
    expect(text).not.toContain('12345678Z');
    expect(text).toContain('••••••78Z');

    // La reserva y su contacto llevan el origen de la visita (no «web_chat»).
    const lead = await db.lead.findFirstOrThrow({
      where: { tenantId: owner.tenantId, email: 'rosa-wc@e2e.local' },
    });
    expect(lead).toMatchObject({ source: 'web_chat', utmSource: 'instagram' });
    expect(lead.metadata).toMatchObject({ bookingChannel: 'web_chat' });
    // Un solo aviso de la reserva (el de la reserva online).
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'web_chat.booking' },
      }),
    ).toBe(0);
    // Quedan trasteros: la lista de espera no hace falta.
    const wait = await chat(owner.slug, {
      visitorId: visitor(),
      message: `espera ${JSON.stringify({ tipo: 'L1-T1', nombre: 'Leo', email: 'leo-wc@e2e.local' })}`,
    }).expect(200);
    expect(wait.body.answer).toContain('quedan');
    expect(
      await db.waitlistEntry.count({
        where: { tenantId: owner.tenantId, contactEmail: 'leo-wc@e2e.local' },
      }),
    ).toBe(0);

    // Lo de hace más de 24 horas ya no se enseña al visitante.
    await db.webChatMessage.updateMany({
      where: { conversationId: conv.id },
      data: { createdAt: new Date(Date.now() - 30 * 3_600_000) },
    });
    await db.webChatConversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date(Date.now() - 30 * 3_600_000) },
    });
    const old = await http()
      .post(`/public/landing/${owner.slug}/chat/history`)
      .send({ visitorId: v })
      .expect(200);
    expect(old.body.messages).toHaveLength(0);
    const quiet = await http()
      .post(`/public/landing/${owner.slug}/chat/updates`)
      .send({ visitorId: v })
      .expect(200);
    expect(quiet.body).toEqual({ active: false, mode: 'ai', staffMessages: 0 });

    // Respuesta del equipo con el chat cerrado: la consulta ligera la cuenta.
    const fresh = visitor();
    await chat(owner.slug, { visitorId: fresh, message: '¿Abrís los domingos?' }).expect(200);
    const seenAt = new Date().toISOString();
    const freshConv = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: fresh },
    });
    await http()
      .post(`/web-chat/conversations/${freshConv.id}/messages`)
      .set(auth)
      .send({ body: 'Sí, de 10 a 14.' })
      .expect(201);
    const updates = await http()
      .post(`/public/landing/${owner.slug}/chat/updates`)
      .send({ visitorId: fresh, after: seenAt })
      .expect(200);
    expect(updates.body).toEqual({ active: true, mode: 'human', staffMessages: 1 });

    // La reserva del chat no sale en «reservas» si fue por WhatsApp; esta sí es de la web.
    const report = await http().get('/marketing/web-analytics?days=7').set(auth).expect(200);
    expect(report.body.totals.bookings).toBeGreaterThanOrEqual(1);
  });

  it('vuelve al asistente sin respuesta del equipo, avisa fuera de horario y apagar el paso libera', async () => {
    const owner = await registerVerifiedUser(app, 'wchours');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // 15 minutos sin respuesta del equipo: contesta el asistente.
    const v = visitor();
    await chat(owner.slug, { visitorId: v, message: '¿Qué precio tiene el grande?' }).expect(200);
    const handoff = await chat(owner.slug, {
      visitorId: v,
      message: 'Quiero hablar con una persona',
    }).expect(200);
    expect(handoff.body.mode).toBe('human');
    await db.webChatConversation.updateMany({
      where: { tenantId: owner.tenantId, visitorId: v },
      data: { handoffRequestedAt: new Date(Date.now() - 16 * 60_000) },
    });
    const back = await chat(owner.slug, { visitorId: v, message: '¿Sigue ahí alguien?' }).expect(
      200,
    );
    expect(back.body.mode).toBe('ai');
    expect(back.body.answer).toContain('El equipo no ha podido responderte todavía');

    // Fuera del horario del equipo: no se pasa a una persona y se piden los datos.
    await http().patch('/web-chat/settings').set(auth).send({ teamHours: {} }).expect(200);
    const outside = visitor();
    await chat(owner.slug, { visitorId: outside, message: 'Hola' }).expect(200);
    const asked = await http()
      .post(`/public/landing/${owner.slug}/chat/handoff`)
      .set('User-Agent', UA)
      .send({ visitorId: outside })
      .expect(200);
    expect(asked.body).toMatchObject({ mode: 'ai', askContact: true });

    // Apagar el paso a una persona devuelve al asistente las que esperaban.
    await http().patch('/web-chat/settings').set(auth).send({ teamHours: null }).expect(200);
    const stuck = visitor();
    await chat(owner.slug, { visitorId: stuck, message: 'Hola' }).expect(200);
    await chat(owner.slug, { visitorId: stuck, message: 'Quiero hablar con una persona' }).expect(
      200,
    );
    await http().patch('/web-chat/settings').set(auth).send({ handoffEnabled: false }).expect(200);
    const released = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: stuck },
    });
    expect(released.mode).toBe('ai');

    // La limpieza diaria devuelve al asistente lo que lleva dos días esperando.
    await http().patch('/web-chat/settings').set(auth).send({ handoffEnabled: true }).expect(200);
    const old = visitor();
    await chat(owner.slug, { visitorId: old, message: 'Hola' }).expect(200);
    await chat(owner.slug, { visitorId: old, message: 'Quiero hablar con una persona' }).expect(
      200,
    );
    await db.webChatConversation.updateMany({
      where: { tenantId: owner.tenantId, visitorId: old },
      data: { lastMessageAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    await app.get(DataRetentionService).runCleanup();
    const cleaned = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: old },
    });
    expect(cleaned.mode).toBe('ai');
  });

  it('el recordatorio reenvía el enlace de firma vigente y el RGPD del inquilino alcanza al chat', async () => {
    const owner = await registerVerifiedUser(app, 'wcsign');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Firma',
      typeName: 'Grande',
      unitsCount: 1,
      pricePerUnit: 70,
    });
    const start = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const v = visitor();
    await chat(owner.slug, {
      visitorId: v,
      message: `reservar ${JSON.stringify({
        tipo: 'L1-T1',
        fecha: start,
        nombre: 'Iván',
        apellidos: 'Sanz',
        email: 'ivan-wc@e2e.local',
        telefono: '600444555',
        documento: '12345678Z',
      })}`,
    }).expect(200);
    const conv = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: v },
    });
    const contractId = conv.contractId!;

    const signatures = app.get(SignaturesService);
    const first = await signatures.generateSigningToken(contractId);
    const again = await signatures.currentOrNewSigningToken(contractId);
    expect(again.token).toBe(first.token);
    // A punto de caducar: uno nuevo.
    await db.contract.update({
      where: { id: contractId },
      data: { signingTokenExpiresAt: new Date(Date.now() + 60_000) },
    });
    const renewed = await signatures.currentOrNewSigningToken(contractId);
    expect(renewed.token).not.toBe(first.token);

    // Exportar y anonimizar al inquilino incluye su conversación del chat.
    const contract = await db.contract.findUniqueOrThrow({ where: { id: contractId } });
    const exported = await http()
      .get(`/rgpd/customers/${contract.customerId}/export`)
      .set(auth)
      .expect(200);
    expect(exported.body.webChatConversations).toHaveLength(1);
    await http().post(`/rgpd/customers/${contract.customerId}/anonymize`).set(auth).expect(204);
    expect(await db.webChatConversation.count({ where: { id: conv.id } })).toBe(0);
  });
});
