import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Asistente de IA del WhatsApp Business (IA y WhatsApp simulados en test):
 * IA de la plataforma con límite mensual, cambio automático a la clave propia
 * del tenant, paso a una persona y pausa cuando responde el equipo.
 */
describe('Asistente de WhatsApp (e2e)', () => {
  let app: INestApplication;
  let prismaAdmin: PrismaAdminService;
  let adminAuth: { Authorization: string };
  const phoneNumberId = `3${Date.now()}`;
  let seq = 0;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    prismaAdmin = app.get(PrismaAdminService);
    const admin = await seedSuperAdmin('wa-ai');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    // La IA de WhatsApp de la plataforma es global: se deja como estaba.
    await request(app.getHttpServer())
      .put('/admin/whatsapp-ai')
      .set(adminAuth)
      .send({ enabled: false, monthlyReplyLimit: 300 });
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
  });

  function inbound(body: string) {
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
                  contacts: [{ wa_id: '34655443322', profile: { name: 'Marta Ruiz' } }],
                  messages: [
                    {
                      id: `wamid.ai-${Date.now()}-${seq}`,
                      from: '34655443322',
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

  /** Espera a que haya `count` respuestas del asistente (se envían en segundo plano). */
  async function assistantReplies(tenantId: string, count: number) {
    for (let i = 0; i < 40; i += 1) {
      const rows = await prismaAdmin.whatsappMessage.findMany({
        where: { tenantId, sender: 'assistant' },
        orderBy: { createdAt: 'asc' },
      });
      if (rows.length >= count) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return prismaAdmin.whatsappMessage.findMany({
      where: { tenantId, sender: 'assistant' },
      orderBy: { createdAt: 'asc' },
    });
  }

  const settle = () => new Promise((r) => setTimeout(r, 600));

  it('límite de la plataforma, cambio a la clave propia, paso a una persona y pausa', async () => {
    // IA de la plataforma con 1 respuesta al mes por tenant.
    const platform = await request(app.getHttpServer())
      .put('/admin/whatsapp-ai')
      .set(adminAuth)
      .send({
        enabled: true,
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-plataforma-de-prueba-123',
        monthlyReplyLimit: 1,
      });
    expect(platform.status).toBe(200);
    expect(platform.body).toMatchObject({ enabled: true, provider: 'openai', keyLast4: '-123' });
    const test = await request(app.getHttpServer()).post('/admin/whatsapp-ai/test').set(adminAuth);
    expect(test.body.ok).toBe(true);

    const owner = await registerVerifiedUser(app, 'wa-ai');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer()).get('/settings/whatsapp/assistant').set(auth).expect(403);
    await setTenantFeatureOverride(owner.slug, 'whatsapp_business', true);
    const tenantId = (await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } }))
      .id;

    await request(app.getHttpServer())
      .put('/settings/whatsapp')
      .set(auth)
      .send({ phoneNumberId, accessToken: 'EAAG-token-de-prueba-555555', enabled: true })
      .expect(200);
    const enabled = await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ assistantEnabled: true, assistantInstructions: 'Abrimos también los sábados.' });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      assistantEnabled: true,
      aiMode: 'platform',
      platformAiAvailable: true,
      ownAi: null,
    });

    // 1ª respuesta: IA de la plataforma.
    await inbound('¿Cuánto cuesta un trastero pequeño?');
    let replies = await assistantReplies(tenantId, 1);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.aiKeySource).toBe('platform');
    expect(replies[0]!.body).toContain('Respuesta automática');

    // 2º mensaje: límite alcanzado y sin clave propia → no responde y avisa.
    await inbound('¿Y uno grande?');
    await settle();
    replies = await assistantReplies(tenantId, 1);
    expect(replies).toHaveLength(1);
    const limitNotice = await prismaAdmin.notification.findFirst({
      where: { tenantId, type: 'whatsapp.ai_unavailable' },
    });
    expect(limitNotice).toBeTruthy();

    // Con clave propia (MiniMax) sigue contestando con la suya.
    const own = await request(app.getHttpServer())
      .put('/settings/whatsapp/assistant')
      .set(auth)
      .send({ ownProvider: 'minimax', ownModel: 'MiniMax-M2', ownApiKey: 'mm-clave-propia-9876' });
    expect(own.body.ownAi).toMatchObject({ provider: 'minimax', keyLast4: '9876' });
    expect(own.body.usage).toMatchObject({ platformRepliesThisMonth: 1, limit: 1 });
    const ownTest = await request(app.getHttpServer())
      .post('/settings/whatsapp/assistant/test')
      .set(auth);
    expect(ownTest.body.ok).toBe(true);

    await inbound('¿Tenéis de 5 m²?');
    replies = await assistantReplies(tenantId, 2);
    expect(replies).toHaveLength(2);
    expect(replies[1]!.aiKeySource).toBe('own');

    // Pide una persona → responde, se calla en la conversación y avisa.
    await inbound('Quiero hablar con una persona, por favor');
    replies = await assistantReplies(tenantId, 3);
    expect(replies).toHaveLength(3);
    expect(replies[2]!.body).not.toContain('[[HUMANO]]');
    const conversation = await prismaAdmin.whatsappConversation.findFirstOrThrow({
      where: { tenantId },
    });
    expect(conversation.assistantEnabled).toBe(false);
    expect(
      await prismaAdmin.notification.findFirst({ where: { tenantId, type: 'whatsapp.handoff' } }),
    ).toBeTruthy();
    await inbound('¿Hola?');
    await settle();
    expect(await assistantReplies(tenantId, 3)).toHaveLength(3);

    // Se reactiva en la conversación; al responder el equipo se vuelve a pausar.
    const resumed = await request(app.getHttpServer())
      .patch(`/whatsapp/conversations/${conversation.id}`)
      .set(auth)
      .send({ assistantEnabled: true });
    expect(resumed.body.assistantEnabled).toBe(true);
    await request(app.getHttpServer())
      .post(`/whatsapp/conversations/${conversation.id}/messages`)
      .set(auth)
      .send({ body: 'Hola Marta, soy Ana. ¿En qué te ayudo?' })
      .expect(201);
    const paused = await prismaAdmin.whatsappConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect(paused.assistantEnabled).toBe(false);

    // El super admin ve el uso y pasa al tenant a su propia clave.
    const adminView = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/whatsapp-ai`)
      .set(adminAuth);
    expect(adminView.body).toMatchObject({
      configured: true,
      aiMode: 'platform',
      ownKeyConfigured: true,
      ownProvider: 'minimax',
      usage: { platformRepliesThisMonth: 1, ownRepliesThisMonth: 2, limit: 1 },
    });
    const switched = await request(app.getHttpServer())
      .put(`/admin/tenants/${tenantId}/whatsapp-ai`)
      .set(adminAuth)
      .send({ aiMode: 'own', aiMonthlyLimit: 50 });
    expect(switched.body).toMatchObject({ aiMode: 'own', aiMonthlyLimit: 50 });
    const tenantView = await request(app.getHttpServer())
      .get('/settings/whatsapp/assistant')
      .set(auth);
    expect(tenantView.body).toMatchObject({ aiMode: 'own', usage: { limit: 50 } });

    // Sin token de admin → 401.
    await request(app.getHttpServer()).get('/admin/whatsapp-ai').expect(401);
  });
});
