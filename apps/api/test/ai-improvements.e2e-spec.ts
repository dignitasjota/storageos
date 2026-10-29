import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { FilesService } from '../src/modules/files/files.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-ai-improve@storageos.local';
const ADDON_SLUG = 'addon-ai-extra-improve-e2e';

/**
 * Clave de IA propia del tenant, oportunidad de «IA ampliada», consultas en
 * «Uso por tenant» y Finanzas, y vista previa y resumen del vaciado.
 */
describe('Asistente IA y vaciado: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${token}` });

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

  it('con su propia clave sigue respondiendo al gastar el límite', async () => {
    const owner = await registerVerifiedUser(app, 'aiownkey');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const saved = await http()
      .put('/ai/settings')
      .set(auth)
      .send({ apiKey: 'sk-ant-propia-9876' })
      .expect(200);
    expect(saved.body).toMatchObject({
      mode: 'platform',
      ownKeyConfigured: true,
      ownKeyLast4: '9876',
    });
    expect(JSON.stringify(saved.body)).not.toContain('sk-ant-propia');
    const row = await db.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } });
    expect(row.aiOwnApiKeyEncrypted).not.toContain('sk-ant');
    const tested = await http().post('/ai/settings/test').set(auth).expect(200);
    expect(tested.body.ok).toBe(true);

    await http()
      .put(`/admin/tenants/${owner.tenantId}/ai-usage`)
      .set(admin())
      .send({ monthlyLimit: 1 })
      .expect(200);
    await http().post('/ai/chat').set(auth).send({ content: 'Hola' }).expect(200);
    // Gastada la del mes: sigue con la suya.
    await http().post('/ai/chat').set(auth).send({ content: 'Otra' }).expect(200);
    const usage = await http().get('/ai/usage').set(auth).expect(200);
    expect(usage.body).toMatchObject({ used: 1, limit: 1, ownQueries: 1, ownKeyConfigured: true });

    // El aviso del límite también llega por correo al propietario.
    const mail = await waitForEmail(owner.email, { subjectIncludes: 'límite del asistente' });
    expect(mail.Text).toContain('propia clave');

    // Siempre con su clave (lo decide el super admin): no cuenta para el límite.
    const own = await http()
      .put(`/admin/tenants/${owner.tenantId}/ai-usage`)
      .set(admin())
      .send({ mode: 'own' })
      .expect(200);
    expect(own.body.mode).toBe('own');
    await http().post('/ai/chat').set(auth).send({ content: 'Más' }).expect(200);
    const after = await http().get('/ai/usage').set(auth).expect(200);
    expect(after.body).toMatchObject({ used: 1, ownQueries: 2 });

    // Sin clave en modo «propia»: no responde.
    await http().put('/ai/settings').set(auth).send({ apiKey: '' }).expect(200);
    const blocked = await http().post('/ai/chat').set(auth).send({ content: 'Sin clave' });
    expect(blocked.status).toBe(503);
    expect(blocked.body.code).toBe('ai_own_key_missing');
  });

  it('propone «IA ampliada» a quien llega al límite dos meses seguidos y lo enseña en uso y finanzas', async () => {
    const owner = await registerVerifiedUser(app, 'aiupsell');
    await setTenantPlan(owner.slug, 'pro');
    await db.subscriptionAddon.upsert({
      where: { slug: ADDON_SLUG },
      update: { isActive: true },
      create: { slug: ADDON_SLUG, name: 'IA ampliada e2e', priceMonthly: 15, grantsAiQueries: 500 },
    });
    await http()
      .put(`/admin/tenants/${owner.tenantId}/ai-usage`)
      .set(admin())
      .send({ monthlyLimit: 2 })
      .expect(200);
    // Dos consultas el mes pasado y dos el anterior (a mitad de mes).
    const now = new Date();
    const midMonth = (back: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15, 12));
    await db.aiUsageEvent.createMany({
      data: [1, 1, 2, 2].map((back) => ({
        tenantId: owner.tenantId,
        feature: 'chat',
        model: 'stub',
        countsAsQuery: true,
        createdAt: midMonth(back),
      })),
    });

    const opp = await http().get('/admin/opportunities').set(admin()).expect(200);
    const addon = (
      opp.body as {
        addonId: string;
        candidates: { tenantId: string; reasons: string[] }[];
        addonName: string;
      }[]
    ).find((a) => a.addonName === 'IA ampliada e2e');
    const candidate = addon?.candidates.find((c) => c.tenantId === owner.tenantId);
    expect(candidate?.reasons.join(' ')).toContain('dos meses seguidos');

    const usage = await http().get('/admin/usage').set(admin()).expect(200);
    const row = (usage.body.rows as { tenantId: string; ai: { queryLimit: number | null } }[]).find(
      (r) => r.tenantId === owner.tenantId,
    );
    expect(row?.ai.queryLimit).toBe(2);
    expect(typeof usage.body.totals.aiRevenueMonthly).toBe('number');

    const finance = await http().get('/admin/finance').set(admin()).expect(200);
    expect(finance.body.ai).toMatchObject({
      revenueMonthly: expect.any(Number),
      queriesThisMonth: expect.any(Number),
    });
  });

  it('la vista previa del vaciado cuenta los ficheros y al terminar avisa al super admin', async () => {
    const owner = await registerVerifiedUser(app, 'aiinvfiles');
    const files = app.get(FilesService);
    await files.putObject({
      bucket: 'invoices',
      key: `${owner.tenantId}/invoices/prueba.pdf`,
      body: Buffer.from('%PDF-1.4 prueba'),
      contentType: 'application/pdf',
    });
    const preview = await http()
      .get(`/admin/tenants/${owner.tenantId}/reset-preview`)
      .set(admin())
      .expect(200);
    expect(preview.body.files).toEqual([
      expect.objectContaining({ label: 'PDF de facturas', objects: 1 }),
    ]);

    await http()
      .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
      .set(admin())
      .send({ confirmSlug: owner.slug, reason: 'Empezar en real', exported: true })
      .expect(200);
    const notice = await db.superAdminNotification.findFirst({
      where: { type: 'tenant.reset', link: `/admin/tenants/${owner.tenantId}` },
    });
    expect(notice?.title).toContain('Datos de prueba borrados');
  });
});
