import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Chatbot de autoservicio del portal del inquilino (IA, provider stub): responde
 * con la FAQ + los datos del propio inquilino; gateado por la feature ai_assistant.
 */
describe('Portal: asistente IA (e2e, stub)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function portalLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('el asistente responde cuando la feature está activa (pro)', async () => {
    const owner = await registerVerifiedUser(app, 'portal-ai');
    await setTenantPlan(owner.slug, 'pro');
    const email = `portal-ai-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    const enabled = await request(app.getHttpServer()).get('/portal/me/ai-enabled').set(pAuth);
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);

    const chat = await request(app.getHttpServer())
      .post('/portal/me/ai-chat')
      .set(pAuth)
      .send({ message: '¿Cuál es el horario de acceso a mi trastero?' });
    expect(chat.status).toBe(201);
    expect(typeof chat.body.answer).toBe('string');
    expect(chat.body.answer.length).toBeGreaterThan(0);
  });

  it('sin la feature (starter) el asistente no está disponible', async () => {
    const owner = await registerVerifiedUser(app, 'portal-ai-off');
    const email = `portal-ai-off-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    const enabled = await request(app.getHttpServer()).get('/portal/me/ai-enabled').set(pAuth);
    expect(enabled.body.enabled).toBe(false);

    await request(app.getHttpServer())
      .post('/portal/me/ai-chat')
      .set(pAuth)
      .send({ message: 'hola' })
      .expect(403);
  });

  it('sin sesión de portal → 401', async () => {
    await request(app.getHttpServer()).get('/portal/me/ai-enabled').expect(401);
  });
});
