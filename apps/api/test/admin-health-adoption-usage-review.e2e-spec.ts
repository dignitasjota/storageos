import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AdminTodayExtrasService } from '../src/modules/admin/admin-today-extras.service';
import { TenantHealthService } from '../src/modules/admin/tenant-health.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Salud, Adopción y Uso del panel super admin. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-health-review@storageos.local';
const DAY = 86_400_000;

interface Factor {
  key: string;
  score: number;
  counted: boolean;
  detail: string;
}

describe('Salud, Adopción y Uso del super admin: revisión (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());
  const hiddenPlanSlug = `oculto-e2e-${Date.now().toString(36)}`;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Salud',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await db.subscriptionPlan.deleteMany({ where: { slug: hiddenPlanSlug } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  /** Precio de lista sin IVA (lo que aporta al mes va sin IVA). */
  async function withoutVat(listPrice: number): Promise<number> {
    const s = await db.platformBillingSettings.findFirst();
    const tax = Number(s?.taxRate ?? 21);
    return (s?.pricesIncludeVat ?? true)
      ? Math.round((listPrice / (1 + tax / 100)) * 100) / 100
      : listPrice;
  }

  /** Tenant que paga un plan (Starter por defecto). */
  async function payingTenant(suffix: string, plan = 'starter') {
    const owner = await registerVerifiedUser(app, suffix);
    const p = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: plan } });
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { planId: p.id, status: 'active' },
    });
    return owner;
  }

  const health = async (tenantId: string) =>
    (await http().get(`/admin/tenants/${tenantId}/health`).set(auth).expect(200)).body as {
      segment: string;
      kind: string;
      score: number;
      trend: number | null;
      lastActivityAt: string | null;
      factors: Factor[];
    };
  const factor = (h: { factors: Factor[] }, key: string) => h.factors.find((f) => f.key === key)!;
  const adoptionOf = async (tenantId: string) => {
    const body = (await http().get('/admin/tenants/adoption').set(auth).expect(200)).body;
    return body.tenants.find((t: { tenantId: string }) => t.tenantId === tenantId);
  };

  it('el último acceso cuenta las sesiones renovadas, no solo el inicio de sesión', async () => {
    const owner = await payingTenant('hrsession');
    const old = new Date(Date.now() - 60 * DAY);
    await db.user.update({ where: { id: owner.userId }, data: { lastLoginAt: old } });
    await db.session.updateMany({
      where: { userId: owner.userId },
      data: { lastUsedAt: new Date() },
    });

    const h = await health(owner.tenantId);
    expect(factor(h, 'engagement').score).toBe(100);
    expect(new Date(h.lastActivityAt!).getTime()).toBeGreaterThan(Date.now() - DAY);
    const today = app.get(AdminTodayExtrasService);
    expect((await today.inactivePaying()).some((t) => t.tenantId === owner.tenantId)).toBe(false);
    const overview = (await http().get('/admin/tenants-overview').set(auth).expect(200)).body as {
      id: string;
      lastTeamLoginAt: string | null;
    }[];
    const row = overview.find((t) => t.id === owner.tenantId);
    if (row) expect(new Date(row.lastTeamLoginAt!).getTime()).toBeGreaterThan(Date.now() - DAY);

    // Sin entrar ni con la sesión: sí sale como «ha dejado de entrar».
    await db.session.updateMany({ where: { userId: owner.userId }, data: { lastUsedAt: old } });
    expect(factor(await health(owner.tenantId), 'engagement').score).toBe(20);
    expect((await today.inactivePaying()).some((t) => t.tenantId === owner.tenantId)).toBe(true);
  });

  it('clientes y pruebas van aparte; la prueba lleva su activación', async () => {
    const trial = await registerVerifiedUser(app, 'hrtrial');
    const paying = await payingTenant('hrpaying');
    const list = (await http().get('/admin/tenants/health').set(auth).expect(200)).body;
    const ids = (list.tenants as { tenantId: string }[]).map((t) => t.tenantId);
    expect(ids).toContain(paying.tenantId);
    expect(ids).not.toContain(trial.tenantId);

    const trials = (await http().get('/admin/tenants/health?segment=trial').set(auth).expect(200))
      .body;
    const t = (trials.tenants as { tenantId: string; kind: string; factors: Factor[] }[]).find(
      (x) => x.tenantId === trial.tenantId,
    )!;
    expect(t.kind).toBe('activation');
    expect(factor(t, 'team').score).toBe(100);
    expect(factor(t, 'contract').score).toBe(0);
    expect(list.counts.trial).toBeGreaterThanOrEqual(1);

    // Una cuenta exenta no ensucia la lista de clientes.
    await db.tenant.update({ where: { id: paying.tenantId }, data: { billingExempt: true } });
    const after = (await http().get('/admin/tenants/health').set(auth).expect(200)).body;
    expect(
      (after.tenants as { tenantId: string }[]).some((x) => x.tenantId === paying.tenantId),
    ).toBe(false);
    const exempt = await health(paying.tenantId);
    expect(exempt.segment).toBe('exempt');
    expect(factor(exempt, 'subscription').counted).toBe(false);
  });

  it('una suscripción cancelada no puntúa como activa', async () => {
    const owner = await payingTenant('hrcancel');
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'cancelled' },
    });
    const h = await health(owner.tenantId);
    expect(h.segment).toBe('unpaid');
    expect(factor(h, 'subscription')).toMatchObject({ score: 10, detail: 'Suscripción cancelada' });
  });

  it('facturación: el prepago no penaliza; sin área de clientes no cuenta', async () => {
    const owner = await payingTenant('hrbilling');
    const customerId = await createCustomer(app, owner.accessToken);
    const { contractId } = await signedContractFor(app, owner.accessToken, { id: customerId });
    // Empieza hoy: aún no le toca factura.
    await db.contract.update({ where: { id: contractId }, data: { startDate: new Date() } });
    const h0 = await health(owner.tenantId);
    // Contrato que aún no ha cumplido un ciclo: no cuenta.
    expect(factor(h0, 'billing').counted).toBe(false);
    // Nadie del área de clientes: no penaliza.
    expect(factor(h0, 'portal').counted).toBe(false);

    // Prepago anual desde hace 400 días con la factura que cubre hasta dentro de 300.
    await db.contract.update({
      where: { id: contractId },
      data: {
        billingIntervalMonths: 12,
        startDate: new Date(Date.now() - 400 * DAY),
        billingStartsOn: null,
      },
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await db.invoice.update({
      where: { id: invoiceId },
      data: {
        contractId,
        status: 'issued',
        issueDate: new Date(Date.now() - 65 * DAY),
        periodStart: new Date(Date.now() - 65 * DAY),
        periodEnd: new Date(Date.now() + 300 * DAY),
      },
    });
    expect(factor(await health(owner.tenantId), 'billing')).toMatchObject({
      counted: true,
      score: 100,
    });

    // Si fuera mensual con la última factura de hace 65 días, iría atrasada.
    await db.contract.update({ where: { id: contractId }, data: { billingIntervalMonths: 1 } });
    await db.invoice.update({
      where: { id: invoiceId },
      data: { periodEnd: new Date(Date.now() - 35 * DAY) },
    });
    expect(factor(await health(owner.tenantId), 'billing').score).toBe(10);

    // Con un inquilino que ha entrado al área de clientes, el factor cuenta.
    await db.customer.update({
      where: { id: customerId },
      data: { portalLastSeenAt: new Date() },
    });
    expect(factor(await health(owner.tenantId), 'portal')).toMatchObject({
      counted: true,
      score: 100,
    });
  });

  it('la foto la guarda la tarea diaria y da la tendencia; consultar no escribe', async () => {
    const owner = await payingTenant('hrsnap');
    const service = app.get(TenantHealthService);
    const before = await db.tenantHealthSnapshot.count({ where: { tenantId: owner.tenantId } });
    await health(owner.tenantId);
    await http().get('/admin/tenants/health').set(auth).expect(200);
    expect(await db.tenantHealthSnapshot.count({ where: { tenantId: owner.tenantId } })).toBe(
      before,
    );

    // Foto del mes pasado (hora de España) con 10 puntos.
    const now = new Date();
    const madrid = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const prev = new Date(Date.UTC(madrid.getFullYear(), madrid.getMonth() - 1, 1));
    await db.tenantHealthSnapshot.create({
      data: { tenantId: owner.tenantId, month: prev, score: 10, level: 'dormant' },
    });
    await service.saveSnapshots();
    const current = await db.tenantHealthSnapshot.findMany({
      where: { tenantId: owner.tenantId, month: { gt: prev } },
    });
    expect(current).toHaveLength(1);
    const h = await health(owner.tenantId);
    expect(h.trend).toBe(h.score - 10);
    expect(current[0]!.score).toBe(h.score);
  });

  it('adopción: control de accesos solo con dispositivos o entradas; IA por consultas recientes', async () => {
    const owner = await payingTenant('hradopt');
    const customerId = await createCustomer(app, owner.accessToken);
    await db.accessCredential.create({
      data: { tenantId: owner.tenantId, customerId, method: 'pin', status: 'active' },
    });
    // Consulta a la IA de hace 100 días: no cuenta como uso.
    await db.aiUsageEvent.create({
      data: {
        tenantId: owner.tenantId,
        feature: 'chat',
        model: 'x',
        countsAsQuery: true,
        createdAt: new Date(Date.now() - 100 * DAY),
      },
    });
    let a = await adoptionOf(owner.tenantId);
    const used = (key: string) =>
      a.features.find((f: { feature: string }) => f.feature === key).used as boolean;
    expect(used('access_control')).toBe(false);
    expect(used('ai_assistant')).toBe(false);

    await db.accessLog.create({
      data: { tenantId: owner.tenantId, customerId, method: 'pin', result: 'allowed' },
    });
    await db.aiUsageEvent.create({
      data: { tenantId: owner.tenantId, feature: 'chat', model: 'x', countsAsQuery: true },
    });
    a = await adoptionOf(owner.tenantId);
    expect(used('access_control')).toBe(true);
    expect(used('ai_assistant')).toBe(true);
    // Aporta lo que el MRR: la cuota sin IVA.
    expect(a.monthlyPaid).toBeCloseTo(await withoutVat(79), 2);
    expect(a.inTrial).toBe(false);
  });

  it('adopción: en prueba aporta 0 y dice lo que pagaría', async () => {
    const owner = await registerVerifiedUser(app, 'hrtrialpay');
    const a = await adoptionOf(owner.tenantId);
    expect(a.inTrial).toBe(true);
    expect(a.monthlyPaid).toBe(0);
    const sub = await db.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
      include: { plan: true },
    });
    if (Number(sub.plan.priceMonthly) > 0) {
      expect(a.wouldPay).toBeCloseTo(await withoutVat(Number(sub.plan.priceMonthly)), 2);
    }
  });

  it('adopción: al tope de trasteros es candidato a un plan con margen', async () => {
    const owner = await payingTenant('hrlimit', 'free');
    const customerId = await createCustomer(app, owner.accessToken);
    const { unitId } = await signedContractFor(app, owner.accessToken, { id: customerId });
    const unit = await db.unit.findUniqueOrThrow({ where: { id: unitId } });
    // 7 de 10: aún no está cerca.
    await db.unit.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        tenantId: owner.tenantId,
        facilityId: unit.facilityId,
        floorId: unit.floorId,
        unitTypeId: unit.unitTypeId,
        code: `LIM-A${i}`,
        widthM: 1,
        depthM: 1,
        heightM: 1,
        basePriceMonthly: 10,
      })),
    });
    let a = await adoptionOf(owner.tenantId);
    expect(a.nearLimit).toBe(false);
    expect(a.tapsLimit).toBe(false);

    // 9 de 10: cerca del límite, pero no candidato.
    await db.unit.createMany({
      data: Array.from({ length: 2 }, (_, i) => ({
        tenantId: owner.tenantId,
        facilityId: unit.facilityId,
        floorId: unit.floorId,
        unitTypeId: unit.unitTypeId,
        code: `LIM-B${i}`,
        widthM: 1,
        depthM: 1,
        heightM: 1,
        basePriceMonthly: 10,
      })),
    });
    a = await adoptionOf(owner.tenantId);
    expect(a.nearLimit).toBe(true);
    expect(a.isCandidate).toBe(false);

    // 10 de 10: topa y es candidato a un plan que no sea el suyo.
    await db.unit.create({
      data: {
        tenantId: owner.tenantId,
        facilityId: unit.facilityId,
        floorId: unit.floorId,
        unitTypeId: unit.unitTypeId,
        code: 'LIM-C0',
        widthM: 1,
        depthM: 1,
        heightM: 1,
        basePriceMonthly: 10,
      },
    });
    a = await adoptionOf(owner.tenantId);
    expect(a.tapsLimit).toBe(true);
    expect(a.isCandidate).toBe(true);
    expect(a.recommendedPlanSlug).not.toBe('free');
    expect(a.limitDetail).toContain('10 de 10 trasteros');
  });

  it('adopción: nunca recomienda un plan oculto', async () => {
    await db.subscriptionPlan.create({
      data: {
        name: 'Oculto e2e',
        slug: hiddenPlanSlug,
        priceMonthly: 100,
        priceYearly: 1000,
        maxUnits: null,
        maxFacilities: null,
        maxUsers: null,
        tenantFeatures: ['ai_assistant', 'cameras', 'sepa', 'bank_reconciliation'],
        isActive: true,
        isPublic: false,
      },
    });
    const owner = await payingTenant('hrhidden');
    await db.aiUsageEvent.create({
      data: { tenantId: owner.tenantId, feature: 'chat', model: 'x', countsAsQuery: true },
    });
    const a = await adoptionOf(owner.tenantId);
    expect(a.isCandidate).toBe(true);
    expect(a.recommendedPlanSlug).not.toBe(hiddenPlanSlug);
  });

  it('uso: el coste de la IA va con el precio de cada modelo', async () => {
    const owner = await payingTenant('hraicost');
    await db.aiUsageEvent.createMany({
      data: [
        {
          tenantId: owner.tenantId,
          feature: 'chat',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
        {
          tenantId: owner.tenantId,
          feature: 'chat',
          model: 'claude-sonnet-4-6',
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
      ],
    });
    const usage = (await http().get('/admin/usage?days=abc').set(auth).expect(200)).body;
    // `days` no numérico → 30 por defecto.
    expect(usage.days).toBe(30);
    const row = usage.rows.find((r: { tenantId: string }) => r.tenantId === owner.tenantId);
    // Haiku 4.5 a 1 $ y Sonnet 4.6 a 3 $ por millón de tokens de entrada.
    expect(row.ai.costUsd).toBeCloseTo(4, 2);
    const models = usage.aiPricing.models as { model: string; known: boolean }[];
    expect(models.find((m) => m.model === 'claude-sonnet-4-6')?.known).toBe(true);
    expect((await http().get('/admin/usage?days=5000').set(auth).expect(200)).body.days).toBe(365);
  });

  it('la ficha de negocio de un tenant trae su uso y su adopción', async () => {
    const owner = await payingTenant('hrbiz');
    const body = (
      await http().get(`/admin/business/tenants/${owner.tenantId}`).set(auth).expect(200)
    ).body;
    expect(body.health.segment).toBe('paying');
    expect(body.adoption).not.toBeNull();
    expect(body.adoption.monthlyPaid).toBeCloseTo(await withoutVat(79), 2);
    expect(typeof body.usage30d.emailsSent).toBe('number');
  });
});
