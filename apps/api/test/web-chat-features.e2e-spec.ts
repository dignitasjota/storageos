import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformAiSettingsService } from '../src/modules/ai/platform-ai-settings.service';
import { WebChatWeeklyCron } from '../src/modules/web-chat/web-chat-weekly.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type {
  PublicWebChatHistoryDto,
  PublicWebChatResultDto,
  WebChatConversationDto,
  WebChatStatsDto,
  WebChatTryResultDto,
} from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Mejoras del chat con IA de la web pública. */
describe('Chat de la web: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());
  const visitor = () => `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const post = (slug: string, path: string, body: Record<string, unknown>) =>
    http().post(`/public/landing/${slug}/${path}`).set('User-Agent', UA).send(body);

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    await db.platformAiSettings.updateMany({ data: { webVisitorDailyLimit: 50 } });
    await app.get(PlatformAiSettingsService).refresh();
  });

  afterAll(async () => {
    await db.platformAiSettings.updateMany({ data: { webVisitorDailyLimit: 15 } });
    await app.get(PlatformAiSettingsService).refresh();
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  async function setup(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    await setTenantPlan(owner.slug, 'pro');
    const units = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Chat',
      typeName: 'Mediano',
      unitsCount: 2,
      pricePerUnit: 50,
    });
    return { owner, auth: { Authorization: `Bearer ${owner.accessToken}` }, ...units };
  }

  it('reserva con el formulario del chat, sin repetir, y nueva conversación', async () => {
    const { owner, auth, facilityId, unitTypeId } = await setup('wcf-book');
    const v = visitor();
    const history = (
      await post(owner.slug, 'chat/history', { visitorId: v, locale: 'es' }).expect(200)
    ).body as PublicWebChatHistoryDto;
    expect(history.bookingsEnabled).toBe(true);

    const form = {
      visitorId: v,
      locale: 'es',
      facilityId,
      unitTypeId,
      startDate: tomorrow(),
      customer: {
        firstName: 'Lucía',
        lastName: 'Pérez',
        email: 'lucia-form@e2e.local',
        phone: '600111222',
        documentNumber: '12345678Z',
      },
      utmSource: 'instagram',
      utmMedium: 'social',
      clickIds: { fbclid: 'fbclid-chat-1' },
    };
    const booked = (await post(owner.slug, 'chat/book', form).expect(200))
      .body as PublicWebChatResultDto;
    expect(booked.answer).toContain('/sign/');
    expect(booked.answer).toContain('Primer pago:');
    expect(booked).toMatchObject({ leadCaptured: true, messageId: expect.any(String) });
    const conv = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: v },
    });
    expect(conv).toMatchObject({ bookedInChat: true, utmSource: 'instagram' });
    const lead = await db.lead.findFirstOrThrow({
      where: { tenantId: owner.tenantId, email: 'lucia-form@e2e.local' },
    });
    expect(lead.clickIds).toEqual({ fbclid: 'fbclid-chat-1' });
    // Lo que se guarda en el chat no lleva el enlace de firma.
    const stored = await db.webChatMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(stored.map((m) => m.role)).toEqual(['visitor', 'assistant']);
    expect(stored[0]!.content).toContain('Formulario de reserva');
    expect(stored[1]!.content).not.toContain('/sign/');

    // Una sola reserva por conversación.
    const again = (await post(owner.slug, 'chat/book', form).expect(200))
      .body as PublicWebChatResultDto;
    expect(again.answer).toContain('Ya tienes una reserva');

    // Un tamaño que no es de este negocio.
    const other = await setup('wcf-book-b');
    const wrong = (
      await post(owner.slug, 'chat/book', {
        ...form,
        visitorId: visitor(),
        facilityId: other.facilityId,
        unitTypeId: other.unitTypeId,
      }).expect(200)
    ).body as PublicWebChatResultDto;
    expect(wrong.answer).toContain('no encuentro ese tamaño');

    // Un robot (campo trampa) no reserva.
    const bot = (
      await post(owner.slug, 'chat/book', { ...form, visitorId: visitor(), hp: 'x' }).expect(200)
    ).body as PublicWebChatResultDto;
    expect(bot.limited).toBe('tenant');

    // Nueva conversación: la anterior sigue en el panel y aquí se empieza de cero.
    await post(owner.slug, 'chat/new', { visitorId: v }).expect(200);
    const fresh = (
      await post(owner.slug, 'chat/history', { visitorId: v, locale: 'es' }).expect(200)
    ).body as PublicWebChatHistoryDto;
    expect(fresh.messages).toHaveLength(0);
    const kept = await db.webChatConversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(kept.visitorId).not.toBe(v);
    expect(kept.visitorId.startsWith(v.slice(0, 48))).toBe(true);
    const page = await http().get('/web-chat/conversations/page').set(auth).expect(200);
    expect((page.body.items as WebChatConversationDto[]).some((c) => c.id === conv.id)).toBe(true);

    // El primer pago cobrado cuenta en las cifras del chat.
    const token = /\/sign\/([^\s]+)/.exec(booked.answer)![1]!;
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Lucía Pérez',
        method: 'typed',
        typedSignature: 'Lucía Pérez',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      })
      .expect(201);
    const invoice = await db.invoice.findFirstOrThrow({
      where: { contractId: conv.contractId!, kind: 'invoice' },
      orderBy: { createdAt: 'asc' },
    });
    await http()
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(invoice.total), methodType: 'cash' })
      .expect(200);
    const stats = (await http().get('/web-chat/stats?days=30').set(auth).expect(200))
      .body as WebChatStatsDto;
    expect(stats).toMatchObject({ bookingsInChat: 1, signedBookings: 1, paidBookings: 1 });
    expect(stats.revenue).toBeGreaterThan(0);
  });

  it('visita al local y presupuesto por email pedidos en el chat', async () => {
    const { owner, auth, facilityId } = await setup('wcf-visit');
    const v = visitor();
    const visit = (
      await post(owner.slug, 'chat', {
        visitorId: v,
        message: `visita ${JSON.stringify({
          local: 'L1',
          fecha: tomorrow(),
          hora: '11:30',
          nombre: 'Ana',
          email: 'ana-visita@e2e.local',
          telefono: '600111333',
        })}`,
      }).expect(200)
    ).body as PublicWebChatResultDto;
    expect(visit.answer).toContain('Centro Chat');
    expect(visit.answer).not.toContain('[[VISITA');
    expect(visit.leadCaptured).toBe(true);
    const lead = await db.lead.findFirstOrThrow({
      where: { tenantId: owner.tenantId, email: 'ana-visita@e2e.local' },
    });
    const visits = await db.leadVisit.findMany({ where: { leadId: lead.id } });
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ facilityId, status: 'scheduled' });
    expect(
      await db.notification.count({ where: { tenantId: owner.tenantId, type: 'web_chat.visit' } }),
    ).toBe(1);

    // Una fecha pasada no se apunta.
    const past = (
      await post(owner.slug, 'chat', {
        visitorId: visitor(),
        message: `visita ${JSON.stringify({ local: 'L1', fecha: '2020-01-01', email: 'b@e2e.local' })}`,
      }).expect(200)
    ).body as PublicWebChatResultDto;
    expect(past.answer).toContain('No he podido apuntar la visita');

    // Presupuesto: correo con el primer pago y el enlace para reservar.
    const quoteVisitor = visitor();
    const quote = (
      await post(owner.slug, 'chat', {
        visitorId: quoteVisitor,
        message: `presupuesto ${JSON.stringify({
          tipo: 'L1-T1',
          email: 'pepe-presu@e2e.local',
          nombre: 'Pepe',
        })}`,
      }).expect(200)
    ).body as PublicWebChatResultDto;
    expect(quote.answer).toContain('pepe-presu@e2e.local');
    const mail = await db.communication.findFirstOrThrow({
      where: { tenantId: owner.tenantId, source: 'web_chat.quote' },
    });
    expect(mail.recipient).toBe('pepe-presu@e2e.local');
    expect(mail.bodyText).toContain('Primer pago:');
    expect(mail.bodyText).toContain(`/book/${owner.slug}`);
    expect(mail.leadId).toEqual(expect.any(String));

    // Un tamaño que no existe o un email no válido: no se envía nada.
    const badQuote = (
      await post(owner.slug, 'chat', {
        visitorId: visitor(),
        message: `presupuesto ${JSON.stringify({ tipo: 'L9-T9', email: 'x@e2e.local' })}`,
      }).expect(200)
    ).body as PublicWebChatResultDto;
    expect(badQuote.answer).toContain('No he podido enviarte el presupuesto');

    const stats = (await http().get('/web-chat/stats?days=30').set(auth).expect(200))
      .body as WebChatStatsDto;
    expect(stats.visitsRequested).toBe(1);
  });

  it('responsable de la conversación, probar el asistente y respuestas que no gustaron', async () => {
    const { owner, auth } = await setup('wcf-team');
    const v = visitor();
    const first = (
      await post(owner.slug, 'chat', {
        visitorId: v,
        message: '¿Tenéis parking para descargar?',
      }).expect(200)
    ).body as PublicWebChatResultDto;
    await post(owner.slug, 'chat/feedback', {
      visitorId: v,
      messageId: first.messageId,
      rating: -1,
    }).expect(200);
    const conv = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: v },
    });

    // Responsable: alguien activo del equipo, con aviso para esa persona.
    const managerAuth = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [],
      tag: 'wcf-manager',
    });
    const me = await http().get('/auth/me').set(managerAuth).expect(200);
    const managerId = me.body.user.id as string;
    await http()
      .patch(`/web-chat/conversations/${conv.id}`)
      .set(auth)
      .send({ assignedToUserId: managerId })
      .expect(200);
    const detail = await http().get('/web-chat/conversations/page').set(auth).expect(200);
    expect(
      (detail.body.items as WebChatConversationDto[]).find((c) => c.id === conv.id),
    ).toMatchObject({ assignedToUserId: managerId, assignedToName: expect.any(String) });
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'web_chat.assigned', userId: managerId },
      }),
    ).toBe(1);
    const nobody = await http()
      .patch(`/web-chat/conversations/${conv.id}`)
      .set(auth)
      .send({ assignedToUserId: '0190f5c2-0000-7000-8000-000000000001' })
      .expect(400);
    expect(nobody.body.code).toBe('user_not_found');
    await http()
      .patch(`/web-chat/conversations/${conv.id}`)
      .set(auth)
      .send({ assignedToUserId: null })
      .expect(200);
    await http().patch(`/web-chat/conversations/${conv.id}`).set(auth).send({}).expect(400);

    // Probar el asistente: dice lo que haría, sin guardar nada.
    const conversationsBefore = await db.webChatConversation.count({
      where: { tenantId: owner.tenantId },
    });
    const tried = (
      await http()
        .post('/web-chat/try')
        .set(auth)
        .send({ message: '¿Tenéis parking?', history: [] })
        .expect(200)
    ).body as WebChatTryResultDto;
    expect(tried.answer.length).toBeGreaterThan(0);
    expect(tried.actions.some((a) => a.includes('No tenía la información'))).toBe(true);
    const booking = (
      await http()
        .post('/web-chat/try')
        .set(auth)
        .send({ message: `reservar ${JSON.stringify({ tipo: 'L1-T1' })}` })
        .expect(200)
    ).body as WebChatTryResultDto;
    expect(booking.actions).toContain('Prepararía una reserva');
    expect(booking.answer).not.toContain('[[RESERVA');
    expect(await db.webChatConversation.count({ where: { tenantId: owner.tenantId } })).toBe(
      conversationsBefore,
    );
    // Sin el asistente IA en el plan, no.
    const starter = await registerVerifiedUser(app, 'wcf-starter');
    await http()
      .post('/web-chat/try')
      .set({ Authorization: `Bearer ${starter.accessToken}` })
      .send({ message: 'Hola' })
      .expect(403);

    // Respuestas que no gustaron: en las cifras y en el aviso de los lunes.
    const stats = (await http().get('/web-chat/stats?days=30').set(auth).expect(200))
      .body as WebChatStatsDto;
    expect(stats.badlyRated).toEqual([
      expect.objectContaining({
        conversationId: conv.id,
        question: '¿Tenéis parking para descargar?',
      }),
    ]);
    await app.get(WebChatWeeklyCron).run();
    const weekly = await db.notification.findMany({
      where: { tenantId: owner.tenantId, type: 'web_chat.weekly_ratings' },
    });
    expect(weekly.length).toBeGreaterThanOrEqual(1);
    expect(weekly[0]!.title).toContain('Una respuesta del chat');
  });

  it('aviso al 80 % de las respuestas del mes, una vez', async () => {
    const { owner } = await setup('wcf-limit');
    await db.tenant.update({ where: { id: owner.tenantId }, data: { webChatMonthlyLimit: 5 } });
    for (let i = 0; i < 4; i += 1) {
      await post(owner.slug, 'chat', { visitorId: visitor(), message: `Hola ${i}` }).expect(200);
    }
    // El aviso sale sin esperar a la respuesta: se da un momento.
    await new Promise((r) => setTimeout(r, 300));
    const near = await db.notification.findMany({
      where: { tenantId: owner.tenantId, type: 'ai.web_chat_limit_near' },
    });
    expect(near).toHaveLength(1);
    expect(near[0]!.body).toContain('4 de 5');
    // Una vez al mes: la siguiente respuesta no repite el aviso.
    await post(owner.slug, 'chat', { visitorId: visitor(), message: 'Hola otra vez' }).expect(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'ai.web_chat_limit_near' },
      }),
    ).toBe(1);
    await db.tenant.update({ where: { id: owner.tenantId }, data: { webChatMonthlyLimit: null } });
  });
});
