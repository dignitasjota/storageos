import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { WhatsappBookingRemindersService } from '../src/modules/whatsapp-business/whatsapp-booking-reminders.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Asistente de WhatsApp (IA y WhatsApp simulados): horario del equipo,
 * intenciones con aviso, resumen al pasar a una persona, borrador de respuesta
 * para el equipo y seguimiento a las 24 h de quien preguntó y no reservó.
 */
describe('Asistente de WhatsApp: horario, intenciones y seguimiento (e2e)', () => {
  let app: INestApplication;
  let prismaAdmin: PrismaAdminService;
  let adminAuth: { Authorization: string };
  const phoneNumberId = `5${Date.now()}`;
  let seq = 0;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prismaAdmin = app.get(PrismaAdminService);
    const admin = await seedSuperAdmin('wa-extra');
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

  function inbound(from: string, body: string) {
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
                  contacts: [{ wa_id: from, profile: { name: 'Elena Mora' } }],
                  messages: [
                    {
                      id: `wamid.extra-${Date.now()}-${seq}`,
                      from,
                      timestamp: String(Math.floor(Date.now() / 1000)),
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

  async function waitFor<T>(fn: () => Promise<T | null | undefined | false>): Promise<T> {
    for (let i = 0; i < 50; i += 1) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout');
  }

  it('horario, intención con aviso, resumen al pasar a una persona y borrador', async () => {
    const owner = await registerVerifiedUser(app, 'wa-extra');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    const tenantId = (await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } }))
      .id;
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'EAAG-token-de-prueba-777777', enabled: true })
      .expect(200);

    // «Solo dentro del horario» sin horario: el asistente no responde.
    const set = await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({
        assistantEnabled: true,
        assistantHoursMode: 'inside',
        teamHours: {},
        alertIntents: ['reclamacion'],
      })
      .expect(200);
    expect(set.body).toMatchObject({ assistantHoursMode: 'inside', alertIntents: ['reclamacion'] });
    await inbound('34611222333', 'Hola, ¿cuánto cuesta?');
    await new Promise((r) => setTimeout(r, 600));
    expect(
      await prismaAdmin.whatsappMessage.count({ where: { tenantId, sender: 'assistant' } }),
    ).toBe(0);

    // Siempre: responde y detecta la intención; una reclamación avisa al equipo.
    await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantHoursMode: 'always' })
      .expect(200);
    await inbound('34611222333', 'Quiero poner una reclamación');
    const conv = await waitFor(() =>
      prismaAdmin.whatsappConversation.findFirst({
        where: { tenantId, intent: 'reclamacion' },
      }),
    );
    expect(
      await prismaAdmin.notification.count({ where: { tenantId, type: 'whatsapp.intent' } }),
    ).toBe(1);
    const list = await request(app.getHttpServer())
      .get('/whatsapp/conversations')
      .set(auth)
      .expect(200);
    expect(list.body[0]).toMatchObject({ intent: 'reclamacion' });

    // Pide una persona: se pausa y deja un resumen para el equipo.
    await inbound('34611222333', 'Quiero hablar con una persona');
    const paused = await waitFor(() =>
      prismaAdmin.whatsappConversation.findFirst({
        where: { id: conv.id, assistantEnabled: false, handoffSummary: { not: null } },
      }),
    );
    expect(paused.handoffSummary).toEqual(expect.any(String));

    // Borrador de respuesta para el equipo.
    const draft = await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${conv.id}/suggest-reply`)
      .set(auth)
      .expect(200);
    expect(draft.body.suggestion.length).toBeGreaterThan(0);
  });

  it('seguimiento a las 24 h de quien preguntó el precio y no reservó', async () => {
    const owner = await registerVerifiedUser(app, 'wa-follow');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    const tenantId = (await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } }))
      .id;
    const pn = `6${Date.now()}`;
    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId: pn, accessToken: 'EAAG-token-de-prueba-888888', enabled: true })
      .expect(200);
    await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({
        assistantEnabled: true,
        followupEnabled: true,
        followupTemplateName: 'seguimiento_consulta',
      })
      .expect(200);
    const lastInboundAt = new Date(Date.now() - 30 * 3_600_000);
    const conv = await prismaAdmin.whatsappConversation.create({
      data: {
        tenantId,
        waId: '34699887766',
        contactName: 'Jorge Sanz',
        intent: 'precio',
        lastInboundAt,
        lastMessageAt: lastInboundAt,
      },
    });
    // Otra que ya reservó: no se le recuerda.
    await prismaAdmin.whatsappConversation.create({
      data: {
        tenantId,
        waId: '34699887700',
        intent: 'reserva',
        lastInboundAt,
        lastMessageAt: lastInboundAt,
        followupSentAt: new Date(),
      },
    });
    const reminders = app.get(WhatsappBookingRemindersService);
    expect(await reminders.sendFollowups()).toBeGreaterThanOrEqual(1);
    const sent = await prismaAdmin.whatsappMessage.findFirst({
      where: { conversationId: conv.id, direction: 'out' },
    });
    expect(sent?.body).toContain('seguimiento_consulta');
    // Una sola vez.
    await reminders.sendFollowups();
    expect(await prismaAdmin.whatsappMessage.count({ where: { conversationId: conv.id } })).toBe(1);
  });
});
