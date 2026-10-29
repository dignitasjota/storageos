import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-ai-limits@storageos.local';
const ADDON_SLUG = 'addon-ai-extra-e2e';

/** Clave y modelo del asistente desde el panel admin y límite de consultas. */
describe('Asistente IA: ajustes y límite de consultas (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${token}` });

  /** El consumo se guarda sin esperar: espera a que llegue a `n`. */
  async function waitUsed(auth: Record<string, string>, n: number) {
    for (let i = 0; i < 40; i++) {
      const res = await http().get('/ai/usage').set(auth);
      if (res.body.used >= n) return res.body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`el consumo no llegó a ${n}`);
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin IA',
        role: 'superadmin',
      },
    });
    await db.platformAiSettings.deleteMany({});
    app = await createTestApp();
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    await db.platformAiSettings.deleteMany({});
    await db.subscriptionAddon.deleteMany({ where: { slug: ADDON_SLUG } });
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('guarda la clave y el modelo en el panel sin devolver la clave', async () => {
    const initial = await http().get('/admin/ai-settings').set(admin()).expect(200);
    expect(initial.body).toMatchObject({
      source: 'demo',
      panelKeyConfigured: false,
      monthlyQueryLimit: 300,
      dailyUserLimit: 50,
    });

    const saved = await http()
      .put('/admin/ai-settings')
      .set(admin())
      .send({ apiKey: 'sk-ant-test-abcd1234', model: 'claude-opus-4-1' })
      .expect(200);
    expect(saved.body).toMatchObject({
      source: 'panel',
      model: 'claude-opus-4-1',
      panelKeyConfigured: true,
      panelKeyLast4: '1234',
    });
    expect(JSON.stringify(saved.body)).not.toContain('sk-ant-test');
    const row = await db.platformAiSettings.findFirstOrThrow();
    expect(row.apiKeyEncrypted).not.toContain('sk-ant');

    const ok = await http().post('/admin/ai-settings/test').set(admin()).expect(200);
    expect(ok.body).toMatchObject({ ok: true, source: 'panel' });

    await http().put('/admin/ai-settings').set(admin()).send({ apiKey: 'invalid-key' });
    const bad = await http().post('/admin/ai-settings/test').set(admin()).expect(200);
    expect(bad.body.ok).toBe(false);

    // Quitar la clave vuelve a las variables de entorno (aquí, modo demo).
    const cleared = await http()
      .put('/admin/ai-settings')
      .set(admin())
      .send({ apiKey: '', model: '' })
      .expect(200);
    expect(cleared.body).toMatchObject({ source: 'demo', panelKeyConfigured: false });

    await http().put('/admin/ai-settings').send({ model: 'x' }).expect(401);
  });

  it('cuenta una consulta por pregunta y corta al llegar al límite del mes', async () => {
    const owner = await registerVerifiedUser(app, 'ailimit');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const start = await http().get('/ai/usage').set(auth).expect(200);
    expect(start.body).toMatchObject({ used: 0, limit: 300, customLimit: false });

    await http()
      .put(`/admin/tenants/${owner.tenantId}/ai-usage`)
      .set(admin())
      .send({ monthlyLimit: 2 })
      .expect(200);

    // Una pregunta que consulta una herramienta son dos llamadas, una consulta.
    const first = await http()
      .post('/ai/chat')
      .set(auth)
      .send({ content: '¿Qué facturas vencidas tengo?' })
      .expect(200);
    expect(first.body.message.toolsUsed).toContain('list_overdue_invoices');
    expect((await waitUsed(auth, 1)).used).toBe(1);

    await http().post('/ai/chat').set(auth).send({ content: 'Hola' }).expect(200);
    const usage = await waitUsed(auth, 2);
    expect(usage).toMatchObject({ used: 2, limit: 2, customLimit: true });

    const blocked = await http().post('/ai/chat').set(auth).send({ content: 'Otra' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('ai_monthly_limit_reached');
    const stream = await http().post('/ai/chat/stream').set(auth).send({ content: 'Otra' });
    expect(stream.status).toBe(429);

    // Aviso al equipo al llegar al límite.
    const notice = await db.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'ai.limit' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notice?.title).toContain('límite');

    // Sin límite propio: el general más el extra contratado.
    const addon = await db.subscriptionAddon.create({
      data: { slug: ADDON_SLUG, name: 'IA ampliada e2e', priceMonthly: 15, grantsAiQueries: 500 },
    });
    await db.tenantSubscriptionAddon.create({
      data: { tenantId: owner.tenantId, addonId: addon.id, priceMonthly: 15 },
    });
    const reset = await http()
      .put(`/admin/tenants/${owner.tenantId}/ai-usage`)
      .set(admin())
      .send({ monthlyLimit: null })
      .expect(200);
    expect(reset.body).toMatchObject({ limit: 800, extra: 500, customLimit: false });
    await http().post('/ai/chat').set(auth).send({ content: 'Ya puedo' }).expect(200);
  });

  it('corta al usuario que pasa del tope diario', async () => {
    const owner = await registerVerifiedUser(app, 'aidaily');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http().put('/admin/ai-settings').set(admin()).send({ dailyUserLimit: 1 }).expect(200);
    try {
      await http().post('/ai/chat').set(auth).send({ content: 'Hola' }).expect(200);
      await waitUsed(auth, 1);
      const res = await http().post('/ai/chat').set(auth).send({ content: 'Otra' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('ai_daily_limit_reached');
    } finally {
      await http().put('/admin/ai-settings').set(admin()).send({ dailyUserLimit: 50 });
    }
  });
});
