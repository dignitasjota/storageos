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
const ADMIN_EMAIL = 'admin-usage-test@storageos.local';

interface UsageRow {
  tenantId: string;
  email: { sent: number; bounced: number; complaints: number; bounceRate: number | null };
  ai: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  storage: { bytes: number; measuredAt: string | null };
}

describe('Uso por tenant (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Usage',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('cuenta la IA, los rebotes y las quejas de cada tenant', async () => {
    const owner = await registerVerifiedUser(app, 'adminusage');
    await setTenantPlan(owner.slug, 'pro');
    const chat = await request(app.getHttpServer())
      .post('/ai/chat')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ content: '¿Qué facturas vencidas tengo?' });
    expect(chat.status).toBe(200);

    // 3 correos aceptados y 1 rebote → 25 % de rebotes; 1 queja de spam.
    for (const status of ['sent', 'delivered', 'sent', 'bounced'] as const) {
      await admin.communication.create({
        data: {
          tenantId: owner.tenantId,
          channel: 'email',
          recipient: 'x@e2e.local',
          bodyText: 'hola',
          status,
        },
      });
    }
    await admin.emailSuppression.create({
      data: {
        email: `spam-${Date.now()}@e2e.local`,
        tenantId: owner.tenantId,
        scope: 'marketing',
        reason: 'complaint',
      },
    });

    // El registro de la IA es asíncrono: esperamos a que aparezca.
    let row: UsageRow | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await request(app.getHttpServer()).get('/admin/usage').set(adminAuth);
      expect(res.status).toBe(200);
      row = (res.body.rows as UsageRow[]).find((r) => r.tenantId === owner.tenantId);
      if (row && row.ai.calls >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // El chat con herramienta hace 2 llamadas al modelo (pide datos y responde).
    expect(row!.ai.calls).toBeGreaterThanOrEqual(2);
    expect(row!.ai.inputTokens).toBeGreaterThan(0);
    expect(row!.email).toMatchObject({ sent: 3, bounced: 1, complaints: 1, bounceRate: 25 });
  });

  it('mide el almacenamiento (solo superadmin) y exige sesión', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/usage/measure-storage')
      .set(adminAuth);
    expect(res.status).toBe(200);
    expect(typeof res.body.tenants).toBe('number');
    const usage = await request(app.getHttpServer()).get('/admin/usage').set(adminAuth);
    expect(usage.body.storageMeasuredAt).not.toBeNull();

    await request(app.getHttpServer()).get('/admin/usage').expect(401);
  });
});
