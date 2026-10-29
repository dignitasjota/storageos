import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformAiSettingsService } from '../src/modules/ai/platform-ai-settings.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Chat con IA de la web pública del tenant. */
describe('Chat de la web (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());
  const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const chat = (slug: string, body: Record<string, unknown>) =>
    http().post(`/public/landing/${slug}/chat`).set('User-Agent', UA).send(body);
  const visitor = () => `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await db.platformAiSettings.updateMany({ data: { webVisitorDailyLimit: 15 } });
    await app.get(PlatformAiSettingsService).refresh();
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('solo con el asistente IA; responde, guarda la conversación y crea el contacto', async () => {
    const owner = await registerVerifiedUser(app, 'webchat');
    // starter no trae el asistente IA.
    const off = await http().get(`/public/landing/${owner.slug}`).expect(200);
    expect(off.body.webChatEnabled).toBe(false);
    await chat(owner.slug, { visitorId: visitor(), message: 'Hola' }).expect(404);

    await setTenantPlan(owner.slug, 'pro');
    const on = await http().get(`/public/landing/${owner.slug}`).expect(200);
    expect(on.body.webChatEnabled).toBe(true);

    const v = visitor();
    const first = await chat(owner.slug, { visitorId: v, message: '¿Qué tamaños tenéis?' }).expect(
      200,
    );
    expect(first.body).toMatchObject({ leadCaptured: false, limited: null });
    expect(first.body.answer.length).toBeGreaterThan(0);

    const second = await chat(owner.slug, {
      visitorId: v,
      message: 'Llamadme, soy Ana: ana-chat@e2e.local',
    }).expect(200);
    expect(second.body.leadCaptured).toBe(true);
    expect(second.body.answer).not.toContain('[[CONTACTO');
    const lead = await db.lead.findFirst({
      where: { tenantId: owner.tenantId, email: 'ana-chat@e2e.local' },
    });
    expect(lead?.source).toBe('web_chat');

    const history = await http()
      .post(`/public/landing/${owner.slug}/chat/history`)
      .send({ visitorId: v })
      .expect(200);
    expect(history.body).toMatchObject({ limited: null, mode: 'ai', leadCaptured: true });
    expect(history.body.suggestions.length).toBeGreaterThan(0);
    expect(history.body.messages).toHaveLength(4);

    // No gasta las consultas del panel.
    const usage = await http()
      .get('/ai/usage')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    expect(usage.body).toMatchObject({ used: 0, webUsed: 2 });

    // El panel ve la conversación y el resumen.
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const convs = await http().get('/web-chat/conversations/page').set(auth).expect(200);
    expect(convs.body.items[0]).toMatchObject({
      messageCount: 4,
      leadId: lead!.id,
      fallbackCount: 0,
    });
    expect(convs.body.nextCursor).toBeNull();
    const msgs = await http()
      .get(`/web-chat/conversations/${convs.body.items[0].id}`)
      .set(auth)
      .expect(200);
    expect(msgs.body).toHaveLength(4);

    // El mismo contacto vuelve desde otro navegador: se suma a su contacto y cuenta una vez.
    await chat(owner.slug, {
      visitorId: visitor(),
      message: 'Soy Ana otra vez: ana-chat@e2e.local',
    }).expect(200);
    const stats = await http().get('/web-chat/stats').set(auth).expect(200);
    expect(stats.body).toMatchObject({
      conversations: 2,
      visitorMessages: 3,
      assistantReplies: 3,
      fallbackReplies: 0,
      leads: 1,
    });

    // Página de 1 en 1.
    const p1 = await http().get('/web-chat/conversations/page?limit=1').set(auth).expect(200);
    expect(p1.body.items).toHaveLength(1);
    const p2 = await http()
      .get(`/web-chat/conversations/page?limit=1&cursor=${p1.body.nextCursor}`)
      .set(auth)
      .expect(200);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });

  it('un contacto no válido no se promete y las respuestas sin IA quedan guardadas', async () => {
    const owner = await registerVerifiedUser(app, 'webchatfb');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Teléfono de 3 cifras: no se crea el contacto y se le piden datos válidos.
    const bad = await chat(owner.slug, { visitorId: visitor(), message: 'Llamadme al 123' }).expect(
      200,
    );
    expect(bad.body.leadCaptured).toBe(false);
    expect(bad.body.answer).toContain('email o un teléfono válidos');
    expect(await db.lead.count({ where: { tenantId: owner.tenantId } })).toBe(0);

    // Mes gastado: la respuesta de respaldo queda en la conversación.
    await db.tenant.update({ where: { id: owner.tenantId }, data: { webChatMonthlyLimit: 0 } });
    const v = visitor();
    await chat(owner.slug, { visitorId: v, message: '¿Abrís el domingo?' }).expect(200);
    const history = await http()
      .post(`/public/landing/${owner.slug}/chat/history`)
      .send({ visitorId: v })
      .expect(200);
    expect(history.body.messages.map((m: { role: string }) => m.role)).toEqual([
      'visitor',
      'assistant',
    ]);
    const page = await http().get('/web-chat/conversations/page').set(auth).expect(200);
    const conv = page.body.items.find((c: { preview: string }) => c.preview.includes('domingo'));
    expect(conv.fallbackCount).toBe(1);
    const msgs = await http().get(`/web-chat/conversations/${conv.id}`).set(auth).expect(200);
    expect(msgs.body[1].fallback).toBe(true);
    const stats = await http().get('/web-chat/stats').set(auth).expect(200);
    expect(stats.body).toMatchObject({ assistantReplies: 1, fallbackReplies: 1 });

    // Modo «clave propia» sin clave: no responde y avisa al negocio (una vez).
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { webChatMonthlyLimit: null, aiMode: 'own' },
    });
    for (let i = 0; i < 2; i++) {
      const own = await chat(owner.slug, { visitorId: visitor(), message: 'Hola' }).expect(200);
      expect(own.body.limited).toBe('tenant');
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await db.notification.count({
        where: { tenantId: owner.tenantId, type: 'ai.web_chat_key_missing' },
      }),
    ).toBe(1);
  });

  it('límites por visitante y por mes; robots y apagado', async () => {
    const owner = await registerVerifiedUser(app, 'webchatlim');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await db.platformAiSettings.updateMany({ data: { webVisitorDailyLimit: 1 } });
    if ((await db.platformAiSettings.count()) === 0) {
      await db.platformAiSettings.create({ data: { webVisitorDailyLimit: 1 } });
    }
    await app.get(PlatformAiSettingsService).refresh();
    const v = visitor();
    await chat(owner.slug, { visitorId: v, message: 'Hola' }).expect(200);
    const capped = await chat(owner.slug, { visitorId: v, message: 'Otra' }).expect(200);
    expect(capped.body.limited).toBe('visitor');
    // Al recargar, el widget ya sabe que no puede seguir y con qué contacto.
    const reloaded = await http()
      .post(`/public/landing/${owner.slug}/chat/history`)
      .send({ visitorId: v })
      .expect(200);
    expect(reloaded.body.limited).toBe('visitor');
    expect(reloaded.body.contact).toEqual(expect.objectContaining({ phone: null, whatsapp: null }));

    // Límite del mes del negocio a 0: no responde con IA.
    await db.tenant.update({ where: { id: owner.tenantId }, data: { webChatMonthlyLimit: 0 } });
    const month = await chat(owner.slug, { visitorId: visitor(), message: 'Hola' }).expect(200);
    expect(month.body.limited).toBe('tenant');

    // Un robot (campo trampa) no gasta nada.
    const bot = await chat(owner.slug, { visitorId: visitor(), message: 'Hola', hp: 'x' }).expect(
      200,
    );
    expect(bot.body.limited).toBe('tenant');

    // Apagado desde Configuración.
    const settings = await http()
      .patch('/web-chat/settings')
      .set(auth)
      .send({ enabled: false, instructions: 'Trata de usted' })
      .expect(200);
    expect(settings.body).toMatchObject({ enabled: false, instructions: 'Trata de usted' });
    const log = await db.auditLog.findFirst({
      where: { tenantId: owner.tenantId, action: 'tenant.web_chat_settings_changed' },
    });
    expect(log?.changes).toEqual({ enabled: false, instructions: true });
    const landing = await http().get(`/public/landing/${owner.slug}`).expect(200);
    expect(landing.body.webChatEnabled).toBe(false);
    await chat(owner.slug, { visitorId: visitor(), message: 'Hola' }).expect(404);
  });

  it('reserva y lista de espera desde el chat, paso a una persona y valoraciones', async () => {
    const owner = await registerVerifiedUser(app, 'webchatbook');
    await setTenantPlan(owner.slug, 'pro');
    await db.platformAiSettings.updateMany({ data: { webVisitorDailyLimit: 15 } });
    await app.get(PlatformAiSettingsService).refresh();
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Chat',
      typeName: 'Mediano',
      unitsCount: 1,
      pricePerUnit: 50,
    });
    const start = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

    // Reserva preparada en el chat: enlace de firma y conversación enlazada.
    const v = visitor();
    const booked = await chat(owner.slug, {
      visitorId: v,
      message: `reservar ${JSON.stringify({
        tipo: 'L1-T1',
        fecha: start,
        nombre: 'Lucía',
        apellidos: 'Pérez',
        email: 'lucia-chat@e2e.local',
        telefono: '600111222',
        documento: '12345678Z',
      })}`,
    }).expect(200);
    expect(booked.body.answer).toContain('/sign/');
    expect(booked.body.answer).not.toContain('[[RESERVA');
    expect(booked.body.messageId).toEqual(expect.any(String));
    const conv = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: v },
    });
    expect(conv).toMatchObject({ bookedInChat: true });
    expect(conv.contractId).toEqual(expect.any(String));

    // Agotado: lista de espera.
    const waiting = await chat(owner.slug, {
      visitorId: visitor(),
      message: `espera ${JSON.stringify({ tipo: 'L1-T1', nombre: 'Pablo', email: 'pablo-chat@e2e.local' })}`,
    }).expect(200);
    expect(waiting.body.answer).toContain('lista de espera');
    expect(
      await db.waitlistEntry.count({
        where: { tenantId: owner.tenantId, contactEmail: 'pablo-chat@e2e.local' },
      }),
    ).toBe(1);

    // 👍 a la respuesta.
    await http()
      .post(`/public/landing/${owner.slug}/chat/feedback`)
      .send({ visitorId: v, messageId: booked.body.messageId, rating: 1 })
      .expect(200);

    // Pregunta sin respuesta y paso a una persona.
    const h = visitor();
    await chat(owner.slug, { visitorId: h, message: '¿Tenéis aparcamiento?' }).expect(200);
    const handoff = await chat(owner.slug, {
      visitorId: h,
      message: 'Quiero hablar con una persona',
    }).expect(200);
    expect(handoff.body.mode).toBe('human');
    // Ya no responde la IA: el mensaje espera al equipo.
    const waitingMsg = await chat(owner.slug, { visitorId: h, message: '¿Hola?' }).expect(200);
    expect(waitingMsg.body).toMatchObject({ mode: 'human', answer: '' });
    const pending = await http().get('/web-chat/pending').set(auth).expect(200);
    expect(pending.body.waiting).toBe(1);
    const hConv = await db.webChatConversation.findFirstOrThrow({
      where: { tenantId: owner.tenantId, visitorId: h },
    });
    expect(hConv.handoffSummary).toEqual(expect.any(String));

    // El equipo responde desde el panel; el visitante lo ve.
    await http()
      .post(`/web-chat/conversations/${hConv.id}/messages`)
      .set(auth)
      .send({ body: 'Hola, soy Marta. Sí, hay aparcamiento.' })
      .expect(201);
    const seen = await http()
      .post(`/public/landing/${owner.slug}/chat/history`)
      .send({ visitorId: h })
      .expect(200);
    expect(seen.body.waitingSince).toBeNull();
    expect(seen.body.messages.at(-1)).toMatchObject({ role: 'staff' });
    // Borrador con IA para el equipo.
    const draft = await http()
      .post(`/web-chat/conversations/${hConv.id}/suggest-reply`)
      .set(auth)
      .expect(200);
    expect(draft.body.suggestion.length).toBeGreaterThan(0);
    // Devuelta al asistente.
    await http()
      .patch(`/web-chat/conversations/${hConv.id}`)
      .set(auth)
      .send({ mode: 'ai' })
      .expect(200);
    const back = await chat(owner.slug, { visitorId: h, message: 'Gracias' }).expect(200);
    expect(back.body.mode).toBe('ai');

    // Datos de contacto si nadie responde.
    const c = visitor();
    await http()
      .post(`/public/landing/${owner.slug}/chat/handoff`)
      .set('User-Agent', UA)
      .send({ visitorId: c })
      .expect(200);
    await http()
      .post(`/public/landing/${owner.slug}/chat/contact`)
      .set('User-Agent', UA)
      .send({ visitorId: c, name: 'Rosa', phone: '600 333 444' })
      .expect(200);
    expect(await db.lead.count({ where: { tenantId: owner.tenantId, phone: '600 333 444' } })).toBe(
      1,
    );

    // Reserva en la web después de chatear: queda enlazada.
    const w = visitor();
    await chat(owner.slug, { visitorId: w, message: 'Hola' }).expect(200);
    await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro Web',
      typeName: 'Grande',
      unitsCount: 1,
      pricePerUnit: 80,
    });
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`).expect(200);
    const fac = avail.body.facilities.find((f: { name: string }) => f.name === 'Centro Web');
    await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: fac.id,
        unitTypeId: fac.unitTypes[0].id,
        startDate: start,
        visitorId: w,
        customer: {
          firstName: 'Iván',
          lastName: 'Ruiz',
          email: 'ivan-chat@e2e.local',
          phone: '600555666',
          documentNumber: '87654321X',
        },
      })
      .expect(201);
    const stats = await http().get('/web-chat/stats').set(auth).expect(200);
    expect(stats.body).toMatchObject({
      bookingsInChat: 1,
      bookedAfterChat: 1,
      handoffs: 2,
      ratingsUp: 1,
      ratingsDown: 0,
    });
    expect(stats.body.unansweredQuestions[0].question).toContain('aparcamiento');
  });

  it('streaming: entrega el texto por partes y el final limpio', async () => {
    const owner = await registerVerifiedUser(app, 'webchatsse');
    await setTenantPlan(owner.slug, 'pro');
    const res = await http()
      .post(`/public/landing/${owner.slug}/chat/stream`)
      .set('User-Agent', UA)
      .send({ visitorId: visitor(), message: 'Quiero hablar con una persona' })
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (chunk: Buffer) => (data += chunk.toString()));
        r.on('end', () => cb(null, data));
      })
      .expect(200);
    const events = String(res.body)
      .split('\n\n')
      .filter((e) => e.startsWith('data:'))
      .map((e) => JSON.parse(e.slice(5)) as Record<string, unknown>);
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).not.toContain('[[');
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ mode: 'human' });
  });
});
