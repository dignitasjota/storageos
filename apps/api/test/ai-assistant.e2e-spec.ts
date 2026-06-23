import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Asistente IA (e2e, provider stub)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('crea conversación, usa una herramienta y persiste el historial', async () => {
    const owner = await registerVerifiedUser(app, 'ai');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Pregunta que el stub mapea a la herramienta list_overdue_invoices.
    const chat = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth)
      .send({ content: '¿Qué facturas vencidas tengo?' });
    expect(chat.status).toBe(200);
    expect(chat.body.conversationId).toBeDefined();
    expect(chat.body.message.role).toBe('assistant');
    expect(chat.body.message.content.length).toBeGreaterThan(0);
    expect(chat.body.message.toolsUsed).toContain('list_overdue_invoices');
    const conversationId = chat.body.conversationId as string;

    // Segundo turno en la misma conversación.
    const followUp = await request(app.getHttpServer())
      .post('/ai/chat')
      .set(auth)
      .send({ conversationId, content: 'Gracias' });
    expect(followUp.status).toBe(200);
    expect(followUp.body.conversationId).toBe(conversationId);

    // El detalle tiene los 4 mensajes (2 user + 2 assistant) en orden.
    const detail = await request(app.getHttpServer())
      .get(`/ai/conversations/${conversationId}`)
      .set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.messages).toHaveLength(4);
    expect(detail.body.messages[0].role).toBe('user');
    expect(detail.body.messages[1].role).toBe('assistant');

    // Lista de conversaciones.
    const list = await request(app.getHttpServer()).get('/ai/conversations').set(auth);
    expect(list.body).toHaveLength(1);

    // Borrar.
    await request(app.getHttpServer())
      .delete(`/ai/conversations/${conversationId}`)
      .set(auth)
      .expect(204);
    const afterDelete = await request(app.getHttpServer()).get('/ai/conversations').set(auth);
    expect(afterDelete.body).toHaveLength(0);
  });

  it('aísla las conversaciones entre usuarios/tenants', async () => {
    const a = await registerVerifiedUser(app, 'aiowner');
    await setTenantPlan(a.slug, 'pro');
    const b = await registerVerifiedUser(app, 'aiother');
    await setTenantPlan(b.slug, 'pro');
    const chat = await request(app.getHttpServer())
      .post('/ai/chat')
      .set({ Authorization: `Bearer ${a.accessToken}` })
      .send({ content: 'Hola' });
    const conversationId = chat.body.conversationId as string;

    // El usuario B no ve la conversación de A → 404.
    const cross = await request(app.getHttpServer())
      .get(`/ai/conversations/${conversationId}`)
      .set({ Authorization: `Bearer ${b.accessToken}` });
    expect(cross.status).toBe(404);
  });
});
