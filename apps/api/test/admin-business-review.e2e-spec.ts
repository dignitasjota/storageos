import { randomUUID } from 'node:crypto';

import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión del apartado Negocio del panel super admin: cifras que cuadran. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-biz-review@storageos.local';

describe('Negocio del super admin: revisión (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Negocio',
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
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  /** Tenant que paga el plan Starter. */
  async function payingTenant(suffix: string): Promise<string> {
    const owner = await registerVerifiedUser(app, suffix);
    const starter = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { planId: starter.id, status: 'active' },
    });
    return owner.tenantId;
  }

  const metrics = async () => (await http().get('/admin/metrics').set(auth).expect(200)).body;

  it('MRR sin los suspendidos; bajas con los anonimizados; pruebas terminadas', async () => {
    const before = await metrics();
    const tenantId = await payingTenant('bizmrr');
    const withTenant = await metrics();
    expect(withTenant.mrr.total).toBeCloseTo(before.mrr.total + 79, 2);
    expect(withTenant.payingTenants).toBe(before.payingTenants + 1);

    // La fecha de salida de la prueba la pone el disparador al pasar a activo.
    const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t.trialEndedAt).toBeTruthy();
    expect(withTenant.trialsEndedThisMonth.converted).toBe(
      before.trialsEndedThisMonth.converted + 1,
    );

    // Suspender a mano no toca la suscripción, pero ya no paga.
    await http()
      .post(`/admin/tenants/${tenantId}/suspend`)
      .set(auth)
      .send({ reason: 'prueba de métricas' })
      .expect(200);
    const suspended = await metrics();
    expect(suspended.mrr.total).toBeCloseTo(before.mrr.total, 2);
    expect(suspended.cancellationsThisMonth).toBe(before.cancellationsThisMonth + 1);

    // Anonimizado: sigue contando como baja del mes (aquí y en «por razón»).
    const reasonsBefore = (
      await http().get('/admin/metrics/churn-by-reason?months=1').set(auth).expect(200)
    ).body;
    await http()
      .post(`/admin/tenants/${tenantId}/anonymize`)
      .set(auth)
      .send({ reason: 'RGPD de prueba' })
      .expect(200);
    const anonymized = await metrics();
    expect(anonymized.cancellationsThisMonth).toBe(before.cancellationsThisMonth + 1);
    const reasonsAfter = (
      await http().get('/admin/metrics/churn-by-reason?months=1').set(auth).expect(200)
    ).body;
    expect(reasonsAfter.totalChurned).toBe(reasonsBefore.totalChurned);
    const gone = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(gone.canceledAt).toBeTruthy();
  });

  it('Finanzas: neto de devoluciones, por forma de cobro y facturado sin sustituidas', async () => {
    const tenantId = await payingTenant('bizfin');
    const before = (await http().get('/admin/finance?months=12').set(auth).expect(200)).body;

    const now = new Date();
    await db.tenantSubscriptionPayment.createMany({
      data: [
        { tenantId, provider: 'sepa', status: 'paid', amount: 79, paidAt: now },
        {
          tenantId,
          provider: 'redsys',
          status: 'refunded',
          amount: 79,
          refundedAmount: 79,
          paidAt: now,
        },
      ],
    });
    const number = Math.floor(Math.random() * 1e9);
    const base = {
      tenantId,
      tenantName: 'Negocio',
      baseAmount: 65.29,
      taxRate: 21,
      taxAmount: 13.71,
      total: 79,
      series: 'E2E',
    };
    await db.platformInvoice.createMany({
      data: [
        { ...base, number, fullNumber: `E2E-${number}`, status: 'rectified' },
        { ...base, number: number + 1, fullNumber: `E2E-${number + 1}`, invoiceType: 'R1' },
      ],
    });

    const after = (await http().get('/admin/finance?months=12').set(auth).expect(200)).body;
    expect(after.collectedTotal).toBeCloseTo(before.collectedTotal + 79, 2);
    expect(after.refundedTotal).toBeCloseTo(before.refundedTotal + 79, 2);
    expect(after.bySource.sepa).toBeCloseTo(before.bySource.sepa + 79, 2);
    expect(after.bySource.redsys).toBeCloseTo(before.bySource.redsys, 2);
    expect(after.invoicedTotal).toBeCloseTo(before.invoicedTotal + 79, 2);
    expect(after.monthly).toHaveLength(12);
    expect(after.monthly[11]).toHaveProperty('sepa');
  });

  it('Uso: la IA con la clave propia no cuenta en el coste', async () => {
    const owner = await registerVerifiedUser(app, 'bizai');
    await db.aiUsageEvent.createMany({
      data: [
        {
          tenantId: owner.tenantId,
          feature: 'whatsapp_own',
          model: 'otro',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
        {
          tenantId: owner.tenantId,
          feature: 'chat',
          model: 'claude',
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
      ],
    });
    const usage = (await http().get('/admin/usage?days=7').set(auth).expect(200)).body;
    const row = usage.rows.find((r: { tenantId: string }) => r.tenantId === owner.tenantId);
    expect(row.ai.calls).toBe(1);
    expect(row.ai.ownKeyCalls).toBe(1);
    expect(row.ai.inputTokens).toBe(1_000_000);
    expect(row.ai.costUsd).toBeCloseTo(usage.aiPricing.inputPerMTokUsd, 2);
  });

  it('Adopción: quien paga la IA como extra no es candidato si Pro le cuesta más', async () => {
    const tenantId = await payingTenant('bizadopt');
    const addon = await db.subscriptionAddon.findFirstOrThrow({
      where: { slug: 'addon-ai-assistant' },
    });
    await db.tenantSubscriptionAddon.create({
      data: { tenantId, addonId: addon.id, priceMonthly: 12, quantity: 1 },
    });
    await db.tenantFeatureOverride.create({
      data: { tenantId, feature: 'ai_assistant', enabled: true, source: 'addon' },
    });
    await db.aiConversation.create({
      data: { tenantId, userId: (await db.user.findFirstOrThrow({ where: { tenantId } })).id },
    });
    const body = (await http().get('/admin/tenants/adoption').set(auth).expect(200)).body;
    const row = body.tenants.find((t: { tenantId: string }) => t.tenantId === tenantId);
    expect(row.monthlyPaid).toBeCloseTo(91, 2);
    expect(row.usesFeatureOutsidePlan).toBe(false);
    expect(row.isCandidate).toBe(false);
  });

  it('Recuperación de cobros: cuenta el cobro automático de Redsys rechazado', async () => {
    const tenantId = await payingTenant('bizretry');
    const before = (
      await http().get('/admin/metrics/payment-retries?months=1').set(auth).expect(200)
    ).body;
    const redsysBefore = before.bySource.find((s: { source: string }) => s.source === 'redsys');

    const failedAt = new Date(Date.now() - 2 * 86_400_000);
    await db.platformRedsysOrder.createMany({
      data: [
        {
          order: randomUUID().replace(/-/g, '').slice(0, 12),
          tenantId,
          amountCents: 7900,
          status: 'failed',
          kind: 'auto',
          createdAt: failedAt,
        },
        {
          order: randomUUID().replace(/-/g, '').slice(0, 12),
          tenantId,
          amountCents: 7900,
          status: 'failed',
          kind: 'auto',
          createdAt: new Date(failedAt.getTime() + 3_600_000),
        },
      ],
    });
    await db.tenantSubscriptionPayment.create({
      data: { tenantId, provider: 'redsys', status: 'paid', amount: 79, paidAt: new Date() },
    });

    const after = (
      await http().get('/admin/metrics/payment-retries?months=1').set(auth).expect(200)
    ).body;
    const redsysAfter = after.bySource.find((s: { source: string }) => s.source === 'redsys');
    // Dos intentos seguidos = un solo cobro fallido, recuperado al pagar.
    expect(redsysAfter.totalFailed).toBe(redsysBefore.totalFailed + 1);
    expect(redsysAfter.recovered).toBe(redsysBefore.recovered + 1);
  });

  it('Salud: una prueba sin fecha de fin no sale como vencida', async () => {
    const owner = await registerVerifiedUser(app, 'bizhealth');
    await db.tenant.update({ where: { id: owner.tenantId }, data: { trialEndsAt: null } });
    const h = (await http().get(`/admin/tenants/${owner.tenantId}/health`).set(auth).expect(200))
      .body;
    const sub = h.factors.find((f: { key: string }) => f.key === 'subscription');
    expect(sub.detail).toBe('En prueba, sin fecha de fin');
    expect(sub.score).toBe(70);
  });
});
