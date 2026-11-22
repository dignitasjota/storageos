import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { MrrSnapshotService } from '../src/modules/admin/mrr-snapshot.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { AdminMetricsMrrMovementMonthDto } from '@storageos/shared';

/**
 * Revisión de Métricas y Finanzas del panel super admin: la prueba sin pagar
 * va aparte, el pago atrasado sigue en el MRR, el MRR es la cuota real sin IVA,
 * lo devuelto va al mes de la devolución y las entradas raras no rompen nada.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-metrics-fin-review@storageos.local';
const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

describe('Métricas y Finanzas del super admin: revisión (e2e)', () => {
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
        fullName: 'Admin Métricas',
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
    await db.platformAlertSettings.updateMany({
      data: { businessAlertsEnabled: true, alertAiCostUsdWeek: 20 },
    });
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  const metrics = async () => (await http().get('/admin/metrics').set(auth).expect(200)).body;

  /** Precio de lista sin IVA, como lo cuenta el MRR. */
  async function withoutVat(listPrice: number): Promise<number> {
    const s = await db.platformBillingSettings.findFirst();
    const tax = Number(s?.taxRate ?? 21);
    return (s?.pricesIncludeVat ?? true) ? listPrice / (1 + tax / 100) : listPrice;
  }

  /** Tenant en el plan Starter con la suscripción en el estado indicado. */
  async function tenantWith(
    suffix: string,
    tenantStatus: 'trial' | 'active',
    subStatus: 'trial' | 'active' | 'past_due' | 'expired',
    period?: { start: Date; end: Date },
  ): Promise<string> {
    const owner = await registerVerifiedUser(app, suffix);
    const starter = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: tenantStatus } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        planId: starter.id,
        status: subStatus,
        ...(period ? { currentPeriodStart: period.start, currentPeriodEnd: period.end } : {}),
      },
    });
    return owner.tenantId;
  }

  it('la prueba sin pagar va aparte: ni activa, ni cliente, ni baja', async () => {
    const owner = await registerVerifiedUser(app, 'mfreadonly');
    const [before, churnBefore, retentionBefore] = await Promise.all([
      metrics(),
      http().get('/admin/metrics/churn-by-reason?months=1').set(auth).expect(200),
      http().get('/admin/metrics/retention?months=1').set(auth).expect(200),
    ]);
    // Lo que hace el fin de la prueba sin pagar: tenant activo, suscripción `expired`.
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { status: 'expired' },
    });

    const after = await metrics();
    expect(after.tenants.readOnly).toBe(before.tenants.readOnly + 1);
    expect(after.tenants.trial).toBe(before.tenants.trial - 1);
    expect(after.tenants.active).toBe(before.tenants.active);
    expect(after.cancellationsThisMonth).toBe(before.cancellationsThisMonth);
    expect(after.trialsEndedThisMonth.toFree).toBe(before.trialsEndedThisMonth.toFree + 1);
    expect(after.trialsEndedThisMonth.churned).toBe(before.trialsEndedThisMonth.churned);

    const churnAfter = (
      await http().get('/admin/metrics/churn-by-reason?months=1').set(auth).expect(200)
    ).body;
    expect(churnAfter.totalChurned).toBe(churnBefore.body.totalChurned);
    const retentionAfter = (
      await http().get('/admin/metrics/retention?months=1').set(auth).expect(200)
    ).body;
    expect(retentionAfter.cohorts[0].size).toBe(retentionBefore.body.cohorts[0].size);

    // Si había pagado y quedó en solo lectura, sí es baja (al acabar su periodo).
    const paid = await tenantWith('mfpaidro', 'active', 'active');
    await db.tenantSubscriptionPayment.create({
      data: { tenantId: paid, provider: 'manual', status: 'paid', amount: 79, paidAt: new Date() },
    });
    const beforePaid = await metrics();
    await db.tenantSubscription.update({
      where: { tenantId: paid },
      data: { status: 'expired', currentPeriodEnd: new Date(Date.now() - 60_000) },
    });
    const afterPaid = await metrics();
    expect(afterPaid.cancellationsThisMonth).toBe(beforePaid.cancellationsThisMonth + 1);
    expect(afterPaid.tenants.readOnly).toBe(beforePaid.tenants.readOnly + 1);
  });

  it('el pago atrasado sigue en el MRR, sin baja ni reactivación', async () => {
    const snapshots = app.get(MrrSnapshotService);
    const tenantId = await tenantWith('mfpastdue', 'active', 'active');
    const net = round2(await withoutVat(79));

    // El mes pasado ya pagaba lo mismo.
    await snapshots.captureMonth(new Date());
    const current = await db.mrrSnapshot.findFirstOrThrow({
      where: { tenantId },
      orderBy: { month: 'desc' },
    });
    await db.mrrSnapshot.create({
      data: {
        tenantId,
        month: new Date(
          Date.UTC(current.month.getUTCFullYear(), current.month.getUTCMonth() - 1, 1),
        ),
        planSlug: 'starter',
        status: 'active',
        mrr: net,
      },
    });
    const baseline = (await snapshots.getMovements(1)).months.at(-1)!;

    const before = await metrics();
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'past_due' } });
    await snapshots.captureMonth(new Date());

    const row = await db.mrrSnapshot.findUniqueOrThrow({
      where: { tenantId_month: { tenantId, month: current.month } },
    });
    expect(row.status).toBe('past_due');
    expect(Number(row.mrr)).toBeCloseTo(net, 2);
    const after = await metrics();
    expect(after.mrr.total).toBeCloseTo(before.mrr.total, 2);
    expect(after.tenants.pastDue).toBe(before.tenants.pastDue + 1);
    expect(after.payingTenants).toBe(before.payingTenants);

    const moved = (await snapshots.getMovements(1)).months.at(-1)!;
    const keys: (keyof AdminMetricsMrrMovementMonthDto)[] = ['churn', 'reactivation', 'newMrr'];
    for (const k of keys) expect(moved[k]).toBeCloseTo(baseline[k] as number, 2);
  });

  it('embudo: el pago atrasado cuenta como «pagan»', async () => {
    const tenantId = await tenantWith('mffunnel', 'trial', 'trial');
    const before = (await http().get('/admin/business/trial-funnel?months=1').set(auth).expect(200))
      .body;
    await db.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'past_due' } });
    const after = (await http().get('/admin/business/trial-funnel?months=1').set(auth).expect(200))
      .body;
    expect(after.totals.converted).toBe(before.totals.converted + 1);
    expect(after.totals.toFree).toBe(before.totals.toFree);
    expect(after.totals.inTrial).toBe(before.totals.inTrial - 1);
  });

  it('MRR: la cuota anual entre 12, sin IVA y con su descuento', async () => {
    const start = new Date(Date.now() - 10 * DAY);
    const tenantId = await tenantWith('mfyearly', 'active', 'active', {
      start,
      end: new Date(start.getTime() + 365 * DAY),
    });
    const starter = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });
    // Último pago del plan: 10 € de descuento sobre 100 € (un 10 %).
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId,
        provider: 'manual',
        status: 'paid',
        amount: 90,
        discount: 10,
        planSlug: 'starter',
        paidAt: new Date(),
        periodStart: start,
        periodEnd: new Date(start.getTime() + 365 * DAY),
      },
    });
    const expected = round2(await withoutVat((Number(starter.priceYearly) / 12) * 0.9));
    const card = (await http().get(`/admin/business/tenants/${tenantId}`).set(auth).expect(200))
      .body;
    expect(card.paying).toBe(true);
    expect(card.mrr.plan).toBeCloseTo(expected, 2);

    const row = (await http().get('/admin/tenants-overview').set(auth).expect(200)).body.find(
      (r: { id: string }) => r.id === tenantId,
    );
    expect(row.monthly).toBeCloseTo(expected, 2);
  });

  it('«que pagan» no cuenta las pruebas, aunque la suscripción esté activa', async () => {
    const before = await metrics();
    await tenantWith('mftrialpay', 'trial', 'active');
    const after = await metrics();
    expect(after.payingTenants).toBe(before.payingTenants);
    expect(after.mrr.total).toBeCloseTo(before.mrr.total, 2);
  });

  it('previsión con poco histórico: no proyecta crecimiento', async () => {
    const snapshots = app.get(MrrSnapshotService);
    const month = (endingMrr: number, newMrr = 0): AdminMetricsMrrMovementMonthDto => ({
      label: 'x',
      newMrr,
      expansion: 0,
      reactivation: 0,
      contraction: 0,
      churn: 0,
      net: newMrr,
      endingMrr,
      nrr: endingMrr > 0 ? 100 : null,
    });
    const spy = jest.spyOn(snapshots, 'getMovements');
    // Solo dos meses cerrados con datos (más el mes en curso).
    spy.mockResolvedValueOnce({
      currency: 'EUR',
      warmingUp: false,
      months: [
        ...Array.from({ length: 10 }, () => month(0)),
        month(100, 100),
        month(200, 100),
        month(300, 100),
      ],
    });
    const few = await snapshots.getForecast(12, 3);
    expect(few.insufficientHistory).toBe(true);
    expect(few.assumptions.basedOnMonths).toBe(2);
    expect(few.points.map((p) => p.mrr)).toEqual([300, 300, 300]);

    // Con cuatro meses cerrados promedia todos (también el que no tuvo altas).
    spy.mockResolvedValueOnce({
      currency: 'EUR',
      warmingUp: false,
      months: [month(100, 100), month(100), month(100), month(200, 100), month(200)],
    });
    const enough = await snapshots.getForecast(12, 1);
    expect(enough.insufficientHistory).toBe(false);
    expect(enough.assumptions.basedOnMonths).toBe(4);
    expect(enough.assumptions.avgNewMrr).toBe(50);
    spy.mockRestore();
  });

  it('Finanzas: lo devuelto va al mes de la devolución; cobros sin factura', async () => {
    const tenantId = await tenantWith('mfrefund', 'active', 'active');
    const before = (await http().get('/admin/finance?months=1').set(auth).expect(200)).body;
    // Cobrado hace tres meses, devuelto ahora.
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId,
        provider: 'stripe',
        status: 'partially_refunded',
        amount: 79,
        refundedAmount: 20,
        paidAt: new Date(Date.now() - 95 * DAY),
        refundedAt: new Date(),
      },
    });
    // Un cobro de este mes sin factura.
    await db.tenantSubscriptionPayment.create({
      data: { tenantId, provider: 'manual', status: 'paid', amount: 79, paidAt: new Date() },
    });
    const after = (await http().get('/admin/finance?months=1').set(auth).expect(200)).body;
    expect(after.refundedTotal).toBeCloseTo(before.refundedTotal + 20, 2);
    expect(after.collectedTotal).toBeCloseTo(before.collectedTotal + 79, 2);
    expect(after.monthly).toHaveLength(1);
    expect(after.monthly[0].refunded).toBeCloseTo(before.monthly[0].refunded + 20, 2);
    expect(after.monthly[0].month).toMatch(/^[a-z]{3} \d{2}$/);
    expect(after.reconciliation.paymentsWithoutInvoice.count).toBe(
      before.reconciliation.paymentsWithoutInvoice.count + 1,
    );
  });

  it('entradas raras: `months` que no es un número y un mes futuro', async () => {
    for (const path of [
      '/admin/finance?months=abc',
      '/admin/metrics?months=abc',
      '/admin/metrics/retention?months=abc',
      '/admin/metrics/mrr-movements?months=abc',
      '/admin/metrics/mrr-forecast?months=abc',
      '/admin/metrics/churn-by-reason?months=abc',
      '/admin/metrics/ltv?months=abc',
      '/admin/metrics/payment-retries?months=abc',
      '/admin/business/trial-funnel?months=abc',
    ]) {
      await http().get(path).set(auth).expect(200);
    }
    const finance = (await http().get('/admin/finance?months=abc').set(auth).expect(200)).body;
    expect(finance.monthly).toHaveLength(12);

    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 2);
    const month = next.toISOString().slice(0, 7);
    const res = await http()
      .get(`/admin/business/monthly-report?month=${month}`)
      .set(auth)
      .expect(400);
    expect(res.body.code).toBe('month_in_future');
  });

  it('avisos de negocio: uno por tenant y con su identificador', async () => {
    const a = await registerVerifiedUser(app, 'mfalerta');
    const b = await registerVerifiedUser(app, 'mfalertb');
    await db.tenant.updateMany({
      where: { id: { in: [a.tenantId, b.tenantId] } },
      data: { name: 'E2E Mismo Nombre' },
    });
    await db.aiUsageEvent.createMany({
      data: [a, b, a].map((t) => ({
        tenantId: t.tenantId,
        feature: 'chat',
        model: 'claude',
        inputTokens: 10_000_000,
        outputTokens: 0,
      })),
    });
    const body = (
      await http()
        .put('/admin/business/alerts/settings')
        .set(auth)
        .send({ enabled: true, aiCostUsdWeek: 1 })
        .expect(200)
    ).body;
    const keys = body.alerts.map(
      (x: { kind: string; tenantId: string | null }) => `${x.kind}:${x.tenantId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const titles = body.alerts.map((x: { title: string }) => x.title);
    expect(new Set(titles).size).toBe(titles.length);
    const mine = body.alerts.filter(
      (x: { tenantId: string }) => x.tenantId === a.tenantId || x.tenantId === b.tenantId,
    );
    expect(mine).toHaveLength(2);
  });
});
