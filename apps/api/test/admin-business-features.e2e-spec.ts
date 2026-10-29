import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Funcionalidades del apartado Negocio del panel super admin. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-biz-features@storageos.local';
const SUPPORT_EMAIL = 'support-biz-features@storageos.local';
const DAY = 86_400_000;

describe('Negocio del super admin: funcionalidades (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let supportAuth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  async function login(email: string, role: 'superadmin' | 'support') {
    await db.superAdmin.deleteMany({ where: { email } });
    await db.superAdmin.create({
      data: { email, passwordHash: await argonHash('AdminTest!23'), fullName: 'Admin', role },
    });
    const res = await http().post('/admin/auth/login').send({ email, password: 'AdminTest!23' });
    return { Authorization: `Bearer ${res.body.accessToken}` };
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    auth = await login(ADMIN_EMAIL, 'superadmin');
    supportAuth = await login(SUPPORT_EMAIL, 'support');
    await db.platformBusinessGoals.deleteMany();
  });

  afterAll(async () => {
    await db.platformBusinessGoals.deleteMany();
    await db.platformAlertSettings.updateMany({
      data: {
        businessAlertsEnabled: true,
        alertMrrDropPct: 10,
        alertChurnPct: 5,
        alertAiCostUsdWeek: 20,
        alertBigTenantMrr: 100,
      },
    });
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  /** Tenant que paga Starter por transferencia, con la cuota a 10 días. */
  async function payingTenant(suffix: string): Promise<string> {
    const owner = await registerVerifiedUser(app, suffix);
    const starter = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        planId: starter.id,
        status: 'active',
        billingMode: 'manual',
        currentPeriodStart: new Date(Date.now() - 20 * DAY),
        currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      },
    });
    return owner.tenantId;
  }

  it('embudo de pruebas: la prueba en curso y la que pasa a pagar', async () => {
    const before = (await http().get('/admin/business/trial-funnel?months=1').set(auth).expect(200))
      .body;
    await registerVerifiedUser(app, 'bizfunnel');
    await payingTenant('bizfunnelpay');
    const after = (await http().get('/admin/business/trial-funnel?months=1').set(auth).expect(200))
      .body;
    expect(after.totals.signups).toBe(before.totals.signups + 2);
    expect(after.totals.inTrial).toBe(before.totals.inTrial + 1);
    expect(after.totals.converted).toBe(before.totals.converted + 1);
    expect(after.cohorts).toHaveLength(1);
    expect(after.conversionPct).not.toBeNull();
  });

  it('periodo elegido y comparación con el anterior', async () => {
    const m = (await http().get('/admin/metrics?months=3').set(auth).expect(200)).body;
    expect(m.monthlyGrowth).toHaveLength(3);
    expect(m.period.months).toBe(3);
    expect(m.period).toHaveProperty('previous.signups');
    const f = (await http().get('/admin/finance?months=3').set(auth).expect(200)).body;
    expect(f.monthly).toHaveLength(3);
    expect(f.previous).toHaveProperty('collectedTotal');
  });

  it('previsión de cobros de los próximos 90 días', async () => {
    const before = (await http().get('/admin/finance/forecast').set(auth).expect(200)).body;
    await payingTenant('bizforecast');
    const after = (await http().get('/admin/finance/forecast').set(auth).expect(200)).body;
    expect(after.buckets).toHaveLength(3);
    // La cuota a 10 días cae en los próximos 30 y se repite cada mes.
    expect(after.buckets[0].byMethod.manual).toBeGreaterThan(before.buckets[0].byMethod.manual);
    expect(after.buckets[1].count).toBeGreaterThan(before.buckets[1].count);
  });

  it('objetivos: los pone el super admin y salen en «Hoy»', async () => {
    await http()
      .put('/admin/business/goals')
      .set(supportAuth)
      .send({ mrrTarget: 1000 })
      .expect(403);
    const target = new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10);
    const g = (
      await http()
        .put('/admin/business/goals')
        .set(auth)
        .send({
          mrrTarget: 1_000_000,
          signupsTargetMonthly: 5,
          trialConversionTargetPct: 30,
          targetDate: target,
        })
        .expect(200)
    ).body;
    expect(g.mrrTarget).toBe(1_000_000);
    expect(g.progress.mrr.target).toBe(1_000_000);
    expect(g.progress.signups.target).toBe(5);
    expect(g.mrrNeededPerMonth).toBeGreaterThan(0);
    const today = (await http().get('/admin/today').set(auth).expect(200)).body;
    expect(today.businessGoals.progress.mrr.target).toBe(1_000_000);

    const cleared = (
      await http()
        .put('/admin/business/goals')
        .set(auth)
        .send({ mrrTarget: null, signupsTargetMonthly: null, trialConversionTargetPct: null })
        .expect(200)
    ).body;
    expect(cleared.progress.mrr).toBeNull();
  });

  it('avisos de negocio: gasto de IA de un tenant y apagarlos', async () => {
    const owner = await registerVerifiedUser(app, 'bizalerts');
    await db.aiUsageEvent.create({
      data: {
        tenantId: owner.tenantId,
        feature: 'chat',
        model: 'claude',
        inputTokens: 10_000_000,
        outputTokens: 0,
      },
    });
    const on = (
      await http()
        .put('/admin/business/alerts/settings')
        .set(auth)
        .send({ enabled: true, aiCostUsdWeek: 1 })
        .expect(200)
    ).body;
    expect(
      on.alerts.some(
        (a: { kind: string; tenantId: string }) =>
          a.kind === 'ai_cost' && a.tenantId === owner.tenantId,
      ),
    ).toBe(true);
    const off = (
      await http()
        .put('/admin/business/alerts/settings')
        .set(auth)
        .send({ enabled: false })
        .expect(200)
    ).body;
    expect(off.alerts).toEqual([]);
    expect(off.settings.enabled).toBe(false);
  });

  it('ficha de negocio del tenant con su salud de 6 factores', async () => {
    const tenantId = await payingTenant('bizcard');
    const b = (await http().get(`/admin/business/tenants/${tenantId}`).set(auth).expect(200)).body;
    expect(b.paying).toBe(true);
    expect(b.mrr.plan).toBe(79);
    expect(b.health.factors).toHaveLength(6);
    expect(b.mrrHistory).toHaveLength(12);
    await http()
      .get('/admin/business/tenants/00000000-0000-0000-0000-000000000000')
      .set(auth)
      .expect(404);
  });

  it('informe mensual en JSON y CSV', async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const json = (
      await http().get(`/admin/business/monthly-report?month=${month}`).set(auth).expect(200)
    ).body;
    expect(json.month).toBe(month);
    expect(json).toHaveProperty('movements.net');
    const csv = await http()
      .get(`/admin/business/monthly-report?month=${month}&format=csv`)
      .set(auth)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Concepto;Valor');
    await http().get('/admin/business/monthly-report?month=2026-13').set(auth).expect(400);
    await http().get('/admin/business/trial-funnel').expect(401);
  });
});
