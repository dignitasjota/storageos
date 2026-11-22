import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { recordTeamActivityDay } from '../src/common/team-activity';
import { TenantHealthService } from '../src/modules/admin/tenant-health.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Mejoras de Salud, Adopción y Uso del panel super admin. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const STAMP = Date.now().toString(36);
const EMAILS = {
  super: `hau-super-${STAMP}@storageos.local`,
  support: `hau-support-${STAMP}@storageos.local`,
  sales: `hau-sales-${STAMP}@storageos.local`,
};
const PASSWORD = 'AdminTest!23';
const DAY = 86_400_000;
const DEFAULT_CLIENT = {
  engagement: 30,
  billing: 20,
  subscription: 20,
  adoption: 15,
  portal: 10,
  support: 5,
};
const DEFAULT_TRIAL = {
  facility: 15,
  units: 15,
  customer: 15,
  contract: 25,
  invoice: 15,
  team: 15,
};

/** Día en hora de España como fecha UTC a medianoche (columnas DATE). */
function madridDay(offsetDays = 0): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const d = new Date(`${parts}T00:00:00.000Z`);
  return new Date(d.getTime() + offsetDays * DAY);
}

interface Factor {
  key: string;
  score: number;
  weight: number;
  counted: boolean;
  detail: string;
}

describe('Salud, Adopción y Uso del super admin: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let superAuth: { Authorization: string };
  let supportAuth: { Authorization: string };
  let salesAuth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  async function login(email: string): Promise<{ Authorization: string }> {
    const res = await http().post('/admin/auth/login').send({ email, password: PASSWORD });
    if (!res.body.accessToken) throw new Error(`login ${email}: ${JSON.stringify(res.body)}`);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    await db.superAdmin.createMany({
      data: [
        { email: EMAILS.super, passwordHash, fullName: 'Dirección', role: 'superadmin' },
        { email: EMAILS.support, passwordHash, fullName: 'Soporte', role: 'support' },
        {
          email: EMAILS.sales,
          passwordHash,
          fullName: 'Comercial',
          role: 'sales',
          salesTwoFactorExempt: true,
        },
      ],
    });
    app = await createTestApp();
    superAuth = await login(EMAILS.super);
    supportAuth = await login(EMAILS.support);
    salesAuth = await login(EMAILS.sales);
    // Pesos y umbrales por defecto (otra ejecución pudo dejarlos cambiados).
    await http()
      .put('/admin/health-settings')
      .set(superAuth)
      .send({
        clientWeights: DEFAULT_CLIENT,
        trialWeights: DEFAULT_TRIAL,
        dropAlertPoints: 15,
        anomalyMultiplier: 3,
        anomalyMinEmails: 500,
        anomalyMinAiUsd: 5,
        anomalyMinStorageMb: 1024,
      })
      .expect(200);
  });

  afterAll(async () => {
    await http()
      .put('/admin/health-settings')
      .set(superAuth)
      .send({ clientWeights: DEFAULT_CLIENT, trialWeights: DEFAULT_TRIAL, dropAlertPoints: 15 });
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  /** Tenant que paga Starter. */
  async function payingTenant(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const p = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { planId: p.id, status: 'active' },
    });
    return owner;
  }

  /** Sin uso del panel en 120 días (inicio de sesión ni sesión renovada). */
  async function makeInactive(userId: string) {
    const old = new Date(Date.now() - 120 * DAY);
    await db.user.update({ where: { id: userId }, data: { lastLoginAt: old } });
    await db.session.updateMany({ where: { userId }, data: { lastUsedAt: old } });
  }

  const health = async (tenantId: string) =>
    (await http().get(`/admin/tenants/${tenantId}/health`).set(superAuth).expect(200)).body as {
      score: number;
      segment: string;
      mrr: number;
      wouldPay: number | null;
      churnRisk: string | null;
      payProbability: number | null;
      payProbabilityLevel: string | null;
      trialDaysLeft: number | null;
      activeDays30: number | null;
      activeUsers30: number | null;
      totalUsers: number;
      factors: Factor[];
      mainDrag: { key: string; lostPoints: number; action: { kind: string; label: string } } | null;
    };
  const factor = (h: { factors: Factor[] }, key: string) => h.factors.find((f) => f.key === key)!;

  async function addonBySlug(slug: string, feature: string | null, price = 20) {
    return (
      (await db.subscriptionAddon.findFirst({ where: { slug } })) ??
      db.subscriptionAddon.create({
        data: { slug, name: `Extra ${slug}`, priceMonthly: price, feature },
      })
    );
  }

  it('actividad real: días y usuarios activos, sin escribir más de una vez al día', async () => {
    const owner = await payingTenant('hauact');
    // El inicio de sesión del alta ya anota el día de hoy.
    const today = await db.tenantActivityDay.findMany({ where: { tenantId: owner.tenantId } });
    expect(today).toHaveLength(1);
    // Volver a anotarlo el mismo día no añade nada.
    const admin = app.get(PrismaAdminService);
    const user = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
    await recordTeamActivityDay(admin, user);
    await recordTeamActivityDay(admin, { ...user, lastActiveDay: null });
    expect(await db.tenantActivityDay.count({ where: { tenantId: owner.tenantId } })).toBe(1);

    // Con menos de un mes de registro, la frecuencia no cuenta (lo reciente manda).
    let h = await health(owner.tenantId);
    expect(h.activeDays30).toBe(1);
    expect(h.activeUsers30).toBe(1);
    expect(h.totalUsers).toBe(1);
    expect(factor(h, 'engagement').score).toBe(100);

    // Un mes de registro: 1 día activo en 30 → la frecuencia baja la actividad.
    await db.tenantActivityDay.create({
      data: { tenantId: owner.tenantId, userId: owner.userId, day: madridDay(-45) },
    });
    h = await health(owner.tenantId);
    expect(h.activeDays30).toBe(1);
    expect(factor(h, 'engagement').score).toBe(63); // (100 + 25) / 2
    expect(factor(h, 'engagement').detail).toContain('1 día activo de 30');

    // 12 días activos en 30 → frecuencia 100.
    await db.tenantActivityDay.createMany({
      data: Array.from({ length: 11 }, (_, i) => ({
        tenantId: owner.tenantId,
        userId: owner.userId,
        day: madridDay(-(i + 1) * 2),
      })),
    });
    h = await health(owner.tenantId);
    expect(h.activeDays30).toBe(12);
    expect(factor(h, 'engagement').score).toBe(100);
  });

  it('riesgo de baja en clientes y probabilidad de pagar en pruebas', async () => {
    const paying = await payingTenant('haurisk');
    await makeInactive(paying.userId);
    const h = await health(paying.tenantId);
    expect(h.segment).toBe('paying');
    expect(['high', 'medium', 'low']).toContain(h.churnRisk);
    expect(h.payProbability).toBeNull();
    // Sin entrar en 120 días la puntuación no llega a 75: al menos riesgo medio.
    expect(h.churnRisk).not.toBe('low');

    const trial = await registerVerifiedUser(app, 'hautrial');
    const t = await health(trial.tenantId);
    expect(t.segment).toBe('trial');
    expect(t.churnRisk).toBeNull();
    expect(t.payProbability).toEqual(expect.any(Number));
    expect(['high', 'medium', 'low']).toContain(t.payProbabilityLevel);
    expect(t.trialDaysLeft).toEqual(expect.any(Number));
    // Sin local ni contratos: lo que más resta es el primer contrato y se ofrece ayuda.
    expect(t.mainDrag?.action.kind).toBe('onboarding_help');
  });

  it('salud con dinero: cuota por tenant y MRR en riesgo que cuadra con la lista', async () => {
    const owner = await payingTenant('haumoney');
    await makeInactive(owner.userId);
    const h = await health(owner.tenantId);
    expect(h.mrr).toBeGreaterThan(0);
    const list = (await http().get('/admin/tenants/health').set(superAuth).expect(200)).body as {
      tenants: { tenantId: string; level: string; mrr: number }[];
      mrrAtRisk: { atRisk: number; dormant: number; total: number };
    };
    const sum = (level: string) =>
      Math.round(
        list.tenants.filter((t) => t.level === level).reduce((a, t) => a + t.mrr, 0) * 100,
      ) / 100;
    expect(list.mrrAtRisk.atRisk).toBeCloseTo(sum('at_risk'), 2);
    expect(list.mrrAtRisk.dormant).toBeCloseTo(sum('dormant'), 2);
    expect(list.mrrAtRisk.total).toBeCloseTo(sum('at_risk') + sum('dormant'), 2);
    expect(list.tenants.find((t) => t.tenantId === owner.tenantId)?.mrr).toBe(h.mrr);
  });

  it('pesos configurables (suman 100, solo superadmin) y el factor que más resta con su acción', async () => {
    const owner = await payingTenant('hauweights');
    await makeInactive(owner.userId);
    const before = await health(owner.tenantId);
    expect(before.mainDrag?.key).toBe('engagement');
    expect(before.mainDrag?.action).toMatchObject({ kind: 'email', label: 'Escribir' });

    const bad = await http()
      .put('/admin/health-settings')
      .set(superAuth)
      .send({ clientWeights: { ...DEFAULT_CLIENT, support: 10 } });
    expect(bad.status).toBe(400);
    await http()
      .put('/admin/health-settings')
      .set(supportAuth)
      .send({ dropAlertPoints: 20 })
      .expect(403);
    // Soporte sí los ve.
    await http().get('/admin/health-settings').set(supportAuth).expect(200);

    const custom = { ...DEFAULT_CLIENT, engagement: 50, adoption: 0, support: 0 };
    const saved = await http()
      .put('/admin/health-settings')
      .set(superAuth)
      .send({ clientWeights: custom })
      .expect(200);
    expect(saved.body.clientWeights).toEqual(custom);
    const after = await health(owner.tenantId);
    expect(factor(after, 'engagement').weight).toBe(0.5);
    // Más peso a la actividad (0 puntos) → la puntuación baja.
    expect(after.score).toBeLessThan(before.score);
    await http()
      .put('/admin/health-settings')
      .set(superAuth)
      .send({ clientWeights: DEFAULT_CLIENT })
      .expect(200);
  });

  it('historial de salud y aviso de caída una sola vez', async () => {
    const owner = await payingTenant('haudrop');
    await makeInactive(owner.userId);
    const service = app.get(TenantHealthService);
    // Foto de hace 8 días con 95 puntos.
    await db.tenantHealthDaily.create({
      data: {
        tenantId: owner.tenantId,
        day: madridDay(-8),
        score: 95,
        level: 'healthy',
        segment: 'paying',
      },
    });
    await db.platformAlertSettings.updateMany({ data: { businessAlertsEnabled: true } });
    await service.saveSnapshots();
    const today = await db.tenantHealthDaily.findFirstOrThrow({
      where: { tenantId: owner.tenantId, day: madridDay() },
    });
    expect(95 - today.score).toBeGreaterThanOrEqual(15);
    const notes = () =>
      db.superAdminNotification.count({
        where: { type: 'health.drop', link: { contains: owner.tenantId } },
      });
    expect(await notes()).toBe(1);
    // Otra pasada el mismo día: no se repite.
    await service.saveSnapshots();
    expect(await service.notifyDrops()).toBe(0);
    expect(await notes()).toBe(1);

    const hist = (
      await http().get(`/admin/tenants/${owner.tenantId}/health/history`).set(superAuth).expect(200)
    ).body;
    expect(hist.daily.length).toBeGreaterThanOrEqual(2);
    expect(hist.monthly.length).toBeGreaterThanOrEqual(1);
    expect(hist.biggestDrop.points).toBe(95 - today.score);

    const alerts = (await http().get('/admin/business/alerts').set(superAuth).expect(200)).body as {
      alerts: { kind: string; tenantId: string | null }[];
    };
    expect(
      alerts.alerts.some((a) => a.kind === 'health_drop' && a.tenantId === owner.tenantId),
    ).toBe(true);

    // La fila de la lista lleva la mini gráfica de las fotos semanales.
    const list = (await http().get('/admin/tenants/health').set(superAuth).expect(200)).body as {
      tenants: { tenantId: string; sparkline: number[] }[];
    };
    expect(list.tenants.find((t) => t.tenantId === owner.tenantId)?.sparkline.length).toBe(1);
  });

  it('adopción por intensidad y «pagan y no usan»', async () => {
    const owner = await payingTenant('hauintensity');
    await db.aiUsageEvent.createMany({
      data: [
        ...Array.from({ length: 3 }, () => ({
          tenantId: owner.tenantId,
          feature: 'chat',
          model: 'claude-test',
          countsAsQuery: true,
        })),
        {
          tenantId: owner.tenantId,
          feature: 'chat',
          model: 'claude-test',
          countsAsQuery: true,
          createdAt: new Date(Date.now() - 60 * DAY),
        },
      ],
    });
    const sepa = await addonBySlug('addon-sepa', 'sepa', 9);
    await db.tenantSubscriptionAddon.create({
      data: { tenantId: owner.tenantId, addonId: sepa.id, priceMonthly: 9, quantity: 1 },
    });
    const body = (await http().get('/admin/tenants/adoption').set(superAuth).expect(200)).body;
    const t = body.tenants.find((x: { tenantId: string }) => x.tenantId === owner.tenantId);
    const ai = t.features.find((f: { feature: string }) => f.feature === 'ai_assistant');
    expect(ai).toMatchObject({ used: true, uses30: 3, uses90: 4 });
    const cameras = t.features.find((f: { feature: string }) => f.feature === 'cameras');
    expect(cameras.uses30).toBeNull();
    expect(t.paidUnused.map((p: { feature: string }) => p.feature)).toContain('sepa');
    expect(t.paidUnusedMonthly).toBeGreaterThan(0);
    expect(t.features.find((f: { feature: string }) => f.feature === 'sepa').paidAddon).toBe(true);
    expect(body.paidUnusedCount).toBeGreaterThanOrEqual(1);
    const fa = body.featureAdoption.find((f: { feature: string }) => f.feature === 'ai_assistant');
    expect(fa.uses30Total).toBeGreaterThanOrEqual(3);
    expect(fa.intensityUnit).toBe('consultas');
  });

  it('candidatos con interés registrado e ingreso extra estimado', async () => {
    const owner = await payingTenant('haucand');
    const wa = await addonBySlug('addon-whatsapp-business', 'whatsapp_business', 29);
    await db.featureInterestEvent.createMany({
      data: Array.from({ length: 3 }, () => ({
        tenantId: owner.tenantId,
        userId: owner.userId,
        feature: 'whatsapp_business',
      })),
    });
    const body = (await http().get('/admin/adoption/candidates').set(supportAuth).expect(200))
      .body as {
      candidates: {
        tenantId: string;
        planSlug: string | null;
        reasons: { kind: string; detail: string }[];
        suggestions: { type: string; id: string; extraMonthly: number }[];
        estimatedExtraMonthly: number;
      }[];
      totalEstimatedMonthly: number;
    };
    const c = body.candidates.find((x) => x.tenantId === owner.tenantId)!;
    expect(c.planSlug).toBe('starter');
    expect(c.reasons.some((r) => r.kind === 'interest' && r.detail.includes('3 veces'))).toBe(true);
    const s = c.suggestions.find((x) => x.type === 'addon' && x.id === wa.id)!;
    expect(s.extraMonthly).toBeGreaterThan(0);
    expect(c.estimatedExtraMonthly).toBeGreaterThanOrEqual(s.extraMonthly);
    expect(body.totalEstimatedMonthly).toBeGreaterThanOrEqual(c.estimatedExtraMonthly);
  });

  it('matriz función × plan, bajas por función y funciones que casi nadie usa', async () => {
    const owner = await payingTenant('haumatrix');
    await db.aiUsageEvent.create({
      data: { tenantId: owner.tenantId, feature: 'chat', model: 'm', countsAsQuery: true },
    });
    const body = (await http().get('/admin/adoption/insights').set(superAuth).expect(200)).body;
    expect(body.plans.some((p: { slug: string }) => p.slug === 'starter')).toBe(true);
    const ai = body.matrix.find((r: { feature: string }) => r.feature === 'ai_assistant');
    expect(ai.byPlan.starter.using).toBeGreaterThanOrEqual(1);
    expect(ai.using).toBeGreaterThanOrEqual(1);
    const cameras = body.retention.find((r: { feature: string }) => r.feature === 'cameras');
    // Se mide por configuración: sin histórico para comparar bajas.
    expect(cameras).toMatchObject({ enoughData: false, usedChurnPct: null });
    const aiRet = body.retention.find((r: { feature: string }) => r.feature === 'ai_assistant');
    expect(aiRet.usedCount + aiRet.notUsedCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.rarelyUsed)).toBe(true);
    expect(typeof body.churnedLast12m).toBe('number');
  });

  it('uso con margen, IA por modelo, almacenamiento por tipo y aviso de consumo anómalo', async () => {
    const owner = await payingTenant('hauusage');
    await db.communication.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({
        tenantId: owner.tenantId,
        channel: 'email' as const,
        status: 'sent' as const,
        recipient: `c${i}@example.com`,
        bodyText: 'Hola',
        sentAt: new Date(),
      })),
    });
    await db.aiUsageEvent.create({
      data: {
        tenantId: owner.tenantId,
        feature: 'chat',
        model: 'claude-sonnet-4-6',
        countsAsQuery: false,
        inputTokens: 1000,
        outputTokens: 500,
      },
    });
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: owner.tenantId,
        provider: 'manual',
        status: 'paid',
        amount: 60.5,
        planSlug: 'starter',
        paidAt: new Date(),
      },
    });
    await db.tenantStorageUsage.upsert({
      where: { tenantId: owner.tenantId },
      create: {
        tenantId: owner.tenantId,
        bytes: BigInt(5_000_000),
        objects: 3,
        byBucket: { 'storageos-uploads': 4_000_000, 'storageos-invoices': 1_000_000 },
      },
      update: {},
    });
    const usage = (await http().get('/admin/usage?days=30').set(superAuth).expect(200)).body;
    const r = usage.rows.find((x: { tenantId: string }) => x.tenantId === owner.tenantId);
    expect(r.planSlug).toBe('starter');
    expect(r.email.sent).toBe(600);
    expect(r.aiByModel[0]).toMatchObject({ model: 'claude-sonnet-4-6', calls: 1 });
    expect(r.storage.byBucket['storageos-uploads']).toBe(4_000_000);
    expect(r.margin.revenue).toBeGreaterThan(0);
    expect(r.margin.margin).toBeLessThanOrEqual(r.margin.revenue);
    expect(r.anomalies.some((a: { kind: string }) => a.kind === 'emails')).toBe(true);
    expect(usage.anomalyCount).toBeGreaterThanOrEqual(1);
    expect(usage.marginMonths).toBe(1);

    const alerts = (await http().get('/admin/business/alerts').set(superAuth).expect(200)).body as {
      alerts: { kind: string; tenantId: string | null; detail: string }[];
    };
    const a = alerts.alerts.find(
      (x) => x.kind === 'usage_anomaly' && x.tenantId === owner.tenantId,
    );
    expect(a?.detail).toContain('600 correos');
  });

  it('evolución del uso y previsión del almacenamiento por tendencia', async () => {
    const owner = await payingTenant('hauevol');
    const now = new Date();
    const monthStart = (back: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const MB = 1024 * 1024;
    await db.tenantStorageUsageHistory.createMany({
      data: [2, 1, 0].map((back) => ({
        tenantId: owner.tenantId,
        month: monthStart(back),
        bytes: BigInt((3 - back) * MB),
        objects: 1,
      })),
    });
    const evo = (
      await http()
        .get(`/admin/usage/evolution?tenantId=${owner.tenantId}&months=6`)
        .set(superAuth)
        .expect(200)
    ).body as {
      months: { storageBytes: number | null; emails: number }[];
      storageForecast: { bytes: number }[];
      storageMonthlyGrowth: number | null;
    };
    expect(evo.months).toHaveLength(6);
    expect(evo.months.filter((m) => m.storageBytes !== null)).toHaveLength(3);
    expect(evo.storageForecast).toHaveLength(6);
    expect(evo.storageForecast[0]!.bytes).toBe(4 * MB);
    expect(evo.storageMonthlyGrowth).toBe(MB);
    // De todos también responde.
    await http().get('/admin/usage/evolution').set(supportAuth).expect(200);
  });

  it('vistas guardadas por página', async () => {
    for (const page of ['health', 'adoption', 'usage']) {
      const saved = await http()
        .post('/admin/saved-views')
        .set(superAuth)
        .send({
          page,
          name: `Vista ${page} ${STAMP}`,
          filters: { plan: 'starter', sortKey: 'mrr' },
        })
        .expect(201);
      const list = (await http().get(`/admin/saved-views?page=${page}`).set(superAuth).expect(200))
        .body as { id: string; filters: { plan: string } }[];
      expect(list.find((v) => v.id === saved.body.id)?.filters.plan).toBe('starter');
      await http().delete(`/admin/saved-views/${saved.body.id}`).set(superAuth).expect(204);
    }
  });

  it('acciones en lote con permisos: soporte etiqueta y crea seguimientos; escribir a varios, no', async () => {
    const a = await payingTenant('haubulka');
    const b = await payingTenant('haubulkb');
    const ids = [a.tenantId, b.tenantId];
    const fu = await http()
      .post('/admin/tenants/bulk-followups')
      .set(supportAuth)
      .send({
        tenantIds: [...ids, '00000000-0000-4000-8000-000000000000'],
        title: 'Llamar para revisar el uso',
        dueDate: '2030-01-15',
      })
      .expect(200);
    expect(fu.body).toEqual({ created: 2, skipped: 1 });
    expect(
      await db.tenantFollowup.count({
        where: { tenantId: { in: ids }, title: 'Llamar para revisar el uso' },
      }),
    ).toBe(2);
    await http()
      .post('/admin/tenants/bulk-followups')
      .set(supportAuth)
      .send({ tenantIds: ids, title: 'x', dueDate: 'mañana' })
      .expect(400);
    await http()
      .post('/admin/tenants/bulk-tags')
      .set(supportAuth)
      .send({ tenantIds: ids, add: ['revisar-uso'] })
      .expect(200);
    await http()
      .post('/admin/announcements')
      .set(supportAuth)
      .send({ audience: 'all', tenantIds: ids, subject: 'Hola equipo', body: 'Texto' })
      .expect(403);
    // El rol comercial no entra en estas páginas.
    await http().get('/admin/tenants/health').set(salesAuth).expect(403);
    await http().get('/admin/adoption/candidates').set(salesAuth).expect(403);
    await http().get('/admin/usage/evolution').set(salesAuth).expect(403);
    await http()
      .post('/admin/tenants/bulk-followups')
      .set(salesAuth)
      .send({ tenantIds: ids, title: 'x', dueDate: '2030-01-15' })
      .expect(403);
  });
});
