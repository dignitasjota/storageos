import { ConfigService } from '@nestjs/config';
import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import { paybackMonths } from '@storageos/shared';
import request from 'supertest';

import {
  madridMonthIndex,
  monthIndexDate,
  monthIndexKey,
  monthIndexStart,
} from '../src/common/saas-metrics';
import { MrrSnapshotService } from '../src/modules/admin/mrr-snapshot.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras de Métricas y Finanzas del panel super admin: desglose del MRR,
 * estados, retención en dinero, escenarios y precisión de la previsión, IVA
 * trimestral, margen, coste de adquisición, concentración, series, desglose de
 * cifras, exportaciones, conciliación por cobro, caja del mes, año pasado y
 * anotaciones. Comprueba también los permisos de soporte y comercial.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-mf-improve@storageos.local';
const SUPPORT_EMAIL = 'support-mf-improve@storageos.local';
const SALES_EMAIL = 'sales-mf-improve@storageos.local';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const TEST_SERIES = 'TEST-MFI';
const VAT_YEAR = 2019;

describe('Métricas y Finanzas del super admin: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let auth: { Authorization: string };
  let supportAuth: { Authorization: string };
  let salesAuth: { Authorization: string };
  let adminId: string;
  let taxRate = 21;
  let includeVat = true;
  const nowIdx = madridMonthIndex(new Date());
  const http = () => request(app.getHttpServer());
  let savedGoals: Awaited<ReturnType<PrismaClient['platformBusinessGoals']['findFirst']>> = null;
  let savedMarketing: Awaited<ReturnType<PrismaClient['platformMarketingSpend']['findUnique']>> =
    null;

  async function login(email: string, role: 'superadmin' | 'support' | 'sales') {
    await db.superAdmin.deleteMany({ where: { email } });
    const created = await db.superAdmin.create({
      data: {
        email,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: `Admin ${role}`,
        role,
        ...(role === 'sales' ? { salesTwoFactorExempt: true } : {}),
      },
    });
    const res = await http().post('/admin/auth/login').send({ email, password: 'AdminTest!23' });
    return { id: created.id, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
  }

  const withoutVat = (n: number) => (includeVat ? n / (1 + taxRate / 100) : n);
  const charged = (n: number) => n / (1 + taxRate / 100);

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
        ...(period
          ? { currentPeriodStart: period.start, currentPeriodEnd: period.end }
          : {
              currentPeriodStart: new Date(Date.now() - 5 * DAY),
              currentPeriodEnd: new Date(Date.now() + 25 * DAY),
            }),
      },
    });
    return owner.tenantId;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    const a = await login(ADMIN_EMAIL, 'superadmin');
    auth = a.auth;
    adminId = a.id;
    supportAuth = (await login(SUPPORT_EMAIL, 'support')).auth;
    salesAuth = (await login(SALES_EMAIL, 'sales')).auth;
    const billing = await db.platformBillingSettings.findFirst();
    taxRate = Number(billing?.taxRate ?? 21);
    includeVat = billing?.pricesIncludeVat ?? true;
    savedGoals = await db.platformBusinessGoals.findFirst();
    savedMarketing = await db.platformMarketingSpend.findUnique({
      where: { month: monthIndexKey(nowIdx) },
    });
    await db.platformInvoice.deleteMany({ where: { series: TEST_SERIES } });
  });

  afterAll(async () => {
    await db.platformInvoice.deleteMany({ where: { series: TEST_SERIES } });
    await db.platformMetricAnnotation.deleteMany({ where: { text: { startsWith: 'MFI ' } } });
    await db.platformFinanceSettings.updateMany({
      data: {
        manualFeePct: 0,
        manualFeeFixed: 0,
        usdEurRate: 0.92,
        emailCost: 0.001,
      },
    });
    await db.platformAlertSettings.updateMany({
      data: { alertConcentrationPct: 25, businessAlertsEnabled: true },
    });
    await db.platformMarketingSpend.deleteMany({ where: { month: monthIndexKey(nowIdx) } });
    if (savedMarketing) {
      await db.platformMarketingSpend.create({
        data: {
          month: savedMarketing.month,
          amount: savedMarketing.amount,
          note: savedMarketing.note,
        },
      });
    }
    await db.platformBusinessGoals.updateMany({
      data: { collectedTargetMonthly: savedGoals?.collectedTargetMonthly ?? null },
    });
    await db.mrrForecast.deleteMany({ where: { madeMonth: monthIndexDate(nowIdx - 2) } });
    await app.close();
    await db.superAdmin.deleteMany({
      where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL, SALES_EMAIL] } },
    });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  const metrics = async () => (await http().get('/admin/metrics').set(auth).expect(200)).body;

  it('MRR con su desglose: mensual, anual repartido, extras y descuentos', async () => {
    const before = (await metrics()).mrrBreakdown;
    const starter = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'starter' } });

    // Paga por años con un 10 % de descuento.
    const start = new Date(Date.now() - 10 * DAY);
    const yearly = await tenantWith('mfiyear', 'active', 'active', {
      start,
      end: new Date(start.getTime() + 365 * DAY),
    });
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: yearly,
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
    // Paga por meses con un extra.
    const monthly = await tenantWith('mfimonth', 'active', 'active');
    const addon = await db.subscriptionAddon.findFirstOrThrow({ where: { isActive: true } });
    await db.tenantSubscriptionAddon.create({
      data: { tenantId: monthly, addonId: addon.id, priceMonthly: 12.1, quantity: 1 },
    });

    const m = await metrics();
    const after = m.mrrBreakdown;
    const yearlyList = Number(starter.priceYearly) / 12;
    expect(after.planYearly - before.planYearly).toBeCloseTo(withoutVat(yearlyList * 0.9), 1);
    expect(after.discounts - before.discounts).toBeCloseTo(withoutVat(yearlyList * 0.1), 1);
    expect(after.planMonthly - before.planMonthly).toBeCloseTo(
      withoutVat(Number(starter.priceMonthly)),
      1,
    );
    expect(after.addons - before.addons).toBeCloseTo(withoutVat(12.1), 1);
    expect(after.yearlyTenants).toBe(before.yearlyTenants + 1);
    expect(after.discountedTenants).toBe(before.discountedTenants + 1);
    expect(after.total).toBeCloseTo(m.mrr.total, 1);
  });

  it('estados de cliente con su MRR y su evolución', async () => {
    const res = async () =>
      (await http().get('/admin/metrics/states?months=3').set(auth).expect(200)).body;
    const before = await res();
    await tenantWith('mfistrial', 'trial', 'trial');
    await tenantWith('mfispd', 'active', 'past_due');
    const after = await res();
    const by = (b: { states: { state: string; count: number; mrr: number }[] }, s: string) =>
      b.states.find((x) => x.state === s)!;
    expect(by(after, 'trial').count).toBe(by(before, 'trial').count + 1);
    expect(by(after, 'trial').mrr).toBeGreaterThan(by(before, 'trial').mrr);
    expect(by(after, 'past_due').count).toBe(by(before, 'past_due').count + 1);
    expect(by(after, 'past_due').mrr).toBeGreaterThan(by(before, 'past_due').mrr);
    expect(after.states.map((s: { state: string }) => s.state)).toEqual([
      'trial',
      'paying',
      'past_due',
      'read_only',
      'churned',
      'free',
    ]);
    expect(after.evolution).toHaveLength(3);
    expect(after.evolution[2].month).toBe(monthIndexKey(nowIdx));
    expect(after.evolution[2].trial).toBeGreaterThanOrEqual(1);
  });

  it('retención en dinero por cohorte y desglose de la cohorte', async () => {
    const owner = await registerVerifiedUser(app, 'mficohort');
    const cohortIdx = nowIdx - 23;
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { createdAt: new Date(monthIndexStart(cohortIdx).getTime() + DAY) },
    });
    for (const [offset, mrr] of [
      [0, 100],
      [1, 50],
      [2, 60],
    ] as const) {
      await db.mrrSnapshot.create({
        data: {
          tenantId: owner.tenantId,
          month: monthIndexDate(cohortIdx + offset),
          planSlug: 'starter',
          status: 'active',
          mrr,
        },
      });
    }
    const body = (await http().get('/admin/metrics/retention?months=24').set(auth).expect(200))
      .body;
    const cohort = body.cohorts[0];
    expect(cohort.startMrr).toBeCloseTo(100, 2);
    expect(cohort.revenueRetention.slice(0, 3)).toEqual([100, 50, 60]);
    expect(cohort.retention[0]).toBe(100);

    const drill = (
      await http()
        .get(`/admin/metrics/breakdown?metric=cohort&month=${monthIndexKey(cohortIdx)}`)
        .set(auth)
        .expect(200)
    ).body;
    expect(drill.rows.map((r: { tenantId: string }) => r.tenantId)).toContain(owner.tenantId);
  });

  it('previsión: tres escenarios, aviso de poco histórico y precisión guardada', async () => {
    const snapshots = app.get(MrrSnapshotService);
    const f = (await http().get('/admin/metrics/mrr-forecast?months=3').set(auth).expect(200)).body;
    expect(f.scenarios.map((s: { key: string }) => s.key)).toEqual([
      'prudent',
      'expected',
      'optimistic',
    ]);
    expect(f.scenarios[1].points).toEqual(f.points);
    expect(typeof f.shortHistory).toBe('boolean');
    for (const s of f.scenarios) expect(s.points).toHaveLength(3);

    // Una previsión hecha hace dos meses para el mes pasado.
    const target = nowIdx - 1;
    await db.mrrForecast.deleteMany({ where: { madeMonth: monthIndexDate(nowIdx - 2) } });
    await db.mrrForecast.create({
      data: {
        madeMonth: monthIndexDate(nowIdx - 2),
        targetMonth: monthIndexDate(target),
        monthsAhead: 1,
        baseMrr: 10,
        prudent: 1,
        expected: 1234.5,
        optimistic: 99_999,
      },
    });
    const g = (await http().get('/admin/metrics/mrr-forecast').set(auth).expect(200)).body;
    const row = g.accuracy.find((a: { month: string }) => a.month === monthIndexKey(target));
    expect(row).toBeDefined();
    expect(row.forecasts[0].expected).toBeCloseTo(1234.5, 2);
    const actual = await db.mrrSnapshot.aggregate({
      where: { month: monthIndexDate(target) },
      _sum: { mrr: true },
    });
    expect(row.actual).toBeCloseTo(Number(actual._sum.mrr ?? 0), 1);

    // El cron la guarda una vez al mes.
    await db.mrrForecast.deleteMany({ where: { madeMonth: monthIndexDate(nowIdx) } });
    expect(await snapshots.saveMonthlyForecast()).toBe(true);
    expect(await snapshots.saveMonthlyForecast()).toBe(false);
    expect(await db.mrrForecast.count({ where: { madeMonth: monthIndexDate(nowIdx) } })).toBe(6);
  });

  it('IVA repercutido por trimestre, con CSV', async () => {
    const t = await registerVerifiedUser(app, 'mfivat');
    const inv = (n: number, month: number, base: number, status = 'issued') =>
      db.platformInvoice.create({
        data: {
          series: TEST_SERIES,
          number: n,
          fullNumber: `${TEST_SERIES}-${n}`,
          tenantId: t.tenantId,
          tenantName: 'MFI IVA',
          baseAmount: base,
          taxRate: 21,
          taxAmount: round2(base * 0.21),
          total: round2(base * 1.21),
          status,
          issuedAt: new Date(Date.UTC(VAT_YEAR, month - 1, 10, 12)),
        },
      });
    await inv(1, 2, 100);
    await inv(2, 5, 50);
    await inv(3, 5, 1000, 'rectified');
    const vat = (await http().get(`/admin/finance/vat-quarterly?year=${VAT_YEAR}`).set(auth)).body;
    expect(vat.quarters[0]).toMatchObject({ label: `1T ${VAT_YEAR}`, base: 100, tax: 21 });
    expect(vat.quarters[1]).toMatchObject({ base: 50, tax: 10.5, total: 60.5, invoices: 1 });
    expect(vat.totals).toMatchObject({ invoices: 2, base: 150, tax: 31.5 });

    const csv = await http()
      .get(`/admin/finance/export.csv?kind=vat&year=${VAT_YEAR}`)
      .set(auth)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(`1T ${VAT_YEAR}`);
    expect(csv.text).toContain('31,5');
  });

  it('margen con los costes configurados, coste de adquisición y caja del mes', async () => {
    await http()
      .put('/admin/finance/settings')
      .set(auth)
      .send({ manualFeePct: 0, manualFeeFixed: 1, emailCost: 0.01, usdEurRate: 1 })
      .expect(200);
    const marginOf = async () =>
      (await http().get('/admin/finance/margin?months=1').set(auth).expect(200)).body;
    const acquisitionOf = async () =>
      (await http().get('/admin/finance/acquisition?months=1').set(auth).expect(200)).body;
    const tenantId = await tenantWith('mfimargin', 'active', 'active');
    const before = await marginOf();
    const acqBefore = await acquisitionOf();

    await db.tenantSubscriptionPayment.create({
      data: { tenantId, provider: 'manual', status: 'paid', amount: 121, paidAt: new Date() },
    });
    await db.aiUsageEvent.create({
      data: { tenantId, feature: 'chat', model: 'x', inputTokens: 1_000_000, outputTokens: 0 },
    });
    await db.platformEmailLog.create({
      data: { tenantId, recipient: 'a@b.c', subject: 'MFI', status: 'sent' },
    });
    await db.salesCommissionItem.create({
      data: {
        repId: adminId,
        tenantId,
        kind: 'sale',
        description: 'MFI venta',
        month: monthIndexKey(nowIdx),
        amount: 5,
      },
    });
    await http()
      .put(`/admin/finance/marketing-spend/${monthIndexKey(nowIdx)}`)
      .set(auth)
      .send({ amount: 300 })
      .expect(200);

    const after = await marginOf();
    const aiUsd = Number(app.get(ConfigService).get('AI_COST_INPUT_PER_MTOK_USD'));
    expect(after.totals.revenue - before.totals.revenue).toBeCloseTo(charged(121), 1);
    expect(after.totals.gatewayFees - before.totals.gatewayFees).toBeCloseTo(1, 2);
    expect(after.totals.aiCost - before.totals.aiCost).toBeCloseTo(aiUsd, 2);
    expect(after.totals.emailCost - before.totals.emailCost).toBeCloseTo(0.01, 2);
    expect(after.emailsSent).toBe(before.emailsSent + 1);
    expect(after.totals.salesCommissions - before.totals.salesCommissions).toBeCloseTo(5, 2);
    expect(after.settings.manualFeeFixed).toBe(1);
    expect(Array.isArray(after.topTenants) && Array.isArray(after.worstTenants)).toBe(true);
    const mine = [...after.topTenants, ...after.worstTenants].find(
      (t: { tenantId: string }) => t.tenantId === tenantId,
    );
    if (mine) expect(mine.costs).toBeCloseTo(1 + aiUsd + 0.01 + 5, 1);

    const acq = await acquisitionOf();
    expect(acq.totals.marketingSpend).toBe(300);
    expect(acq.totals.salesSpend - acqBefore.totals.salesSpend).toBeCloseTo(5, 2);
    expect(acq.totals.newPaying).toBeGreaterThanOrEqual(1);
    expect(acq.totals.cac).toBeCloseTo(
      (acq.totals.salesSpend + acq.totals.marketingSpend) / acq.totals.newPaying,
      1,
    );
    expect(acq.paybackMonths).toBe(paybackMonths(acq.totals.cac, acq.arpa, acq.grossMarginPct));

    // Caja del mes frente al objetivo.
    await http()
      .put('/admin/business/goals')
      .set(auth)
      .send({ collectedTargetMonthly: 1000 })
      .expect(200);
    const cash = (await http().get('/admin/finance/cash-month').set(auth).expect(200)).body;
    expect(cash.target).toBe(1000);
    expect(cash.collected).toBeGreaterThanOrEqual(121);
    expect(cash.collectedPct).toBeCloseTo((cash.collected / 1000) * 100, 1);
    expect(cash.projected).toBeCloseTo(cash.collected + cash.expectedRest, 1);
    const goals = (await http().get('/admin/business/goals').set(auth).expect(200)).body;
    expect(goals.collectedTargetMonthly).toBe(1000);
    expect(goals.progress.collected.target).toBe(1000);
  });

  it('concentración de ingresos y su aviso', async () => {
    await tenantWith('mficonc1', 'active', 'active');
    await tenantWith('mficonc2', 'active', 'active');
    const c = (await http().get('/admin/metrics/concentration').set(auth).expect(200)).body;
    expect(c.payingTenants).toBeGreaterThanOrEqual(2);
    expect(c.top1Pct).toBeLessThanOrEqual(c.top5Pct);
    expect(c.top5Pct).toBeLessThanOrEqual(c.top10Pct);
    expect(c.top[0].sharePct).toBeCloseTo(c.top1Pct, 1);
    expect(c.hhi).toBeGreaterThan(0);

    const settings = await http()
      .put('/admin/business/alerts/settings')
      .set(auth)
      .send({ enabled: true, concentrationPct: 1 })
      .expect(200);
    expect(settings.body.settings.concentrationPct).toBe(1);
    expect(settings.body.alerts.some((a: { kind: string }) => a.kind === 'concentration')).toBe(
      true,
    );
    const off = await http()
      .put('/admin/business/alerts/settings')
      .set(auth)
      .send({ concentrationPct: 100 })
      .expect(200);
    expect(off.body.alerts.some((a: { kind: string }) => a.kind === 'concentration')).toBe(false);
  });

  it('series por plan, extra, forma de cobro y comercial', async () => {
    const tenantId = await tenantWith('mfiseries', 'active', 'active');
    await db.tenantSubscriptionPayment.create({
      data: { tenantId, provider: 'manual', status: 'paid', amount: 50, paidAt: new Date() },
    });
    const get = async (by: string) =>
      (await http().get(`/admin/metrics/revenue-series?by=${by}&months=3`).set(auth).expect(200))
        .body;
    const plan = await get('plan');
    expect(plan.basis).toBe('mrr');
    expect(plan.labels).toHaveLength(3);
    expect(plan.series.some((s: { key: string }) => s.key === 'starter')).toBe(true);
    const source = await get('source');
    expect(source.basis).toBe('collected');
    const manual = source.series.find((s: { key: string }) => s.key === 'manual');
    expect(manual.values[2]).toBeGreaterThanOrEqual(50);
    expect((await get('addon')).labels).toHaveLength(3);
    const rep = await get('rep');
    expect(rep.series.length).toBeGreaterThan(0);
    await http().get('/admin/metrics/revenue-series?by=nada').set(auth).expect(400);
  });

  it('clic en una cifra: los tenants que la forman', async () => {
    const trial = await tenantWith('mfibdtrial', 'trial', 'trial');
    const pastDue = await tenantWith('mfibdpd', 'active', 'past_due');
    const ids = async (q: string) =>
      (await http().get(`/admin/metrics/breakdown?${q}`).set(auth).expect(200)).body.rows.map(
        (r: { tenantId: string }) => r.tenantId,
      );
    expect(await ids('metric=trial')).toContain(trial);
    expect(await ids('metric=past_due')).toContain(pastDue);
    expect(await ids('metric=paying')).toContain(pastDue);
    expect(await ids('metric=plan&plan=starter')).toContain(pastDue);
    expect(await ids(`metric=signups&month=${monthIndexKey(nowIdx)}`)).toEqual(
      expect.arrayContaining([trial, pastDue]),
    );
    const mv = (
      await http().get('/admin/metrics/breakdown?metric=movement&kind=new').set(auth).expect(200)
    ).body;
    expect(Array.isArray(mv.rows)).toBe(true);
    await http().get('/admin/metrics/breakdown?metric=nada').set(auth).expect(400);
    await http().get('/admin/metrics/breakdown?metric=movement').set(auth).expect(400);
    await http().get('/admin/metrics/breakdown?metric=signups&month=2099-01').set(auth).expect(400);
  });

  it('exportar: CSV de Finanzas y PDF', async () => {
    for (const kind of ['monthly', 'providers', 'margin', 'reconciliation']) {
      const res = await http().get(`/admin/finance/export.csv?kind=${kind}`).set(auth).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
    }
    await http().get('/admin/finance/export.csv?kind=nada').set(auth).expect(400);
    const pdf = await http()
      .get('/admin/finance/report.pdf?months=3')
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);

  it('conciliación cobro a cobro, con y sin IVA, y el año pasado', async () => {
    const tenantId = await tenantWith('mfirecon', 'active', 'active');
    const payment = await db.tenantSubscriptionPayment.create({
      data: { tenantId, provider: 'manual', status: 'paid', amount: 33, paidAt: new Date() },
    });
    const invoice = await db.platformInvoice.create({
      data: {
        series: TEST_SERIES,
        number: 100,
        fullNumber: `${TEST_SERIES}-100`,
        tenantId,
        tenantName: 'MFI conciliación',
        baseAmount: 10,
        taxRate: 21,
        taxAmount: 2.1,
        total: 12.1,
      },
    });
    const withVatBefore = (await http().get('/admin/finance?months=1').set(auth).expect(200)).body;
    // Un cobro del mismo mes del año pasado.
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId,
        provider: 'manual',
        status: 'paid',
        amount: 77,
        paidAt: new Date(monthIndexStart(nowIdx - 12).getTime() + HOUR),
      },
    });
    const withVat = (await http().get('/admin/finance?months=1').set(auth).expect(200)).body;
    expect(withVat.vatIncluded).toBe(true);
    expect(withVat.lastYear.collectedTotal - withVatBefore.lastYear.collectedTotal).toBeCloseTo(
      77,
      2,
    );
    const p = withVat.reconciliation.payments.find((x: { id: string }) => x.id === payment.id);
    expect(p).toMatchObject({ tenantId, amount: 33 });
    const i = withVat.reconciliation.invoices.find((x: { id: string }) => x.id === invoice.id);
    expect(i).toMatchObject({ fullNumber: `${TEST_SERIES}-100`, total: 12.1 });

    const without = (await http().get('/admin/finance?months=1&vat=without').set(auth).expect(200))
      .body;
    expect(without.vatIncluded).toBe(false);
    expect(without.collectedTotal).toBeCloseTo(charged(withVat.collectedTotal), 0);
  });

  it('comparación con el mismo mes del año pasado en Métricas', async () => {
    const tenantId = await tenantWith('mfily', 'active', 'active');
    const before = await metrics();
    await db.mrrSnapshot.create({
      data: {
        tenantId,
        month: monthIndexDate(nowIdx - 12),
        planSlug: 'starter',
        status: 'active',
        mrr: 77,
      },
    });
    const after = await metrics();
    expect((after.lastYear.mrr ?? 0) - (before.lastYear.mrr ?? 0)).toBeCloseTo(77, 2);
    expect(after.lastYear.payingTenants).toBe((before.lastYear.payingTenants ?? 0) + 1);
    expect(typeof after.lastYear.signupsThisMonth).toBe('number');
    expect(after.period.lastYear).toMatchObject({
      signups: expect.any(Number),
      cancellations: expect.any(Number),
      collected: expect.any(Number),
    });
  });

  it('anotaciones: CRUD del super admin', async () => {
    const created = (
      await http()
        .post('/admin/metrics/annotations')
        .set(auth)
        .send({ date: '2026-03-15', text: 'MFI campaña de primavera' })
        .expect(201)
    ).body;
    expect(created).toMatchObject({ month: '2026-03', authorName: 'Admin superadmin' });
    const list = (await http().get('/admin/metrics/annotations').set(auth).expect(200)).body;
    expect(list.some((a: { id: string }) => a.id === created.id)).toBe(true);
    const updated = (
      await http()
        .patch(`/admin/metrics/annotations/${created.id}`)
        .set(auth)
        .send({ text: 'MFI nuevo precio' })
        .expect(200)
    ).body;
    expect(updated.text).toBe('MFI nuevo precio');
    await http()
      .post('/admin/metrics/annotations')
      .set(auth)
      .send({ date: 'mal', text: 'MFI x' })
      .expect(400);
    await http().delete(`/admin/metrics/annotations/${created.id}`).set(auth).expect(204);
    await http().delete(`/admin/metrics/annotations/${created.id}`).set(auth).expect(404);
  });

  it('permisos: soporte lee y no cambia; el comercial no ve Métricas ni Finanzas', async () => {
    await http().get('/admin/metrics/states').set(supportAuth).expect(200);
    await http().get('/admin/finance/margin').set(supportAuth).expect(200);
    await http().get('/admin/metrics/annotations').set(supportAuth).expect(200);
    await http()
      .post('/admin/metrics/annotations')
      .set(supportAuth)
      .send({ date: '2026-01-01', text: 'MFI soporte' })
      .expect(403);
    await http().put('/admin/finance/settings').set(supportAuth).send({ emailCost: 1 }).expect(403);
    await http()
      .put(`/admin/finance/marketing-spend/${monthIndexKey(nowIdx)}`)
      .set(supportAuth)
      .send({ amount: 1 })
      .expect(403);
    await http().get('/admin/metrics/concentration').set(salesAuth).expect(403);
    await http().get('/admin/finance/cash-month').set(salesAuth).expect(403);
  });
});
