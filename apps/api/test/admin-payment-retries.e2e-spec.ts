import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-retries-test@storageos.local';

/** Instrumentación de fallos de cobro + retry analysis del SaaS. */
describe('Retry analysis de cobros (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let token: string;
  let billing: BillingSaasService;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Retries',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    billing = app.get(BillingSaasService, { strict: false });
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('persiste el fallo de cobro, marca la recuperación al cobrarse y lo agrega', async () => {
    const owner = await registerVerifiedUser(app, 'retries'); // starter, 49 €
    const stamp = Date.now();
    const cus = `cus_retry_${stamp}`;
    // El customer de Stripe resuelve el tenant en el pago recuperado.
    await admin.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { stripeCustomerId: cus },
    });

    const failInvoice = (id: string) =>
      ({
        id,
        customer: cus,
        currency: 'eur',
        amount_due: 4900,
        metadata: { tenantId: owner.tenantId },
        lines: { data: [] },
      }) as unknown as Parameters<typeof billing.recordInvoicePaymentFailed>[0];

    // Factura 1: falla dos veces (reintento) y luego se cobra → recuperada.
    await billing.recordInvoicePaymentFailed(failInvoice(`in_a_${stamp}`));
    await billing.recordInvoicePaymentFailed(failInvoice(`in_a_${stamp}`));
    // Factura 2: falla y NO se recupera → en riesgo.
    await billing.recordInvoicePaymentFailed(failInvoice(`in_b_${stamp}`));

    const rowA1 = await admin.tenantSubscriptionPayment.findFirst({
      where: { externalId: `in_a_${stamp}` },
    });
    expect(rowA1!.status).toBe('failed');
    expect(rowA1!.failedAttempts).toBe(2);
    expect(rowA1!.firstFailedAt).toBeTruthy();
    expect(rowA1!.recoveredAt).toBeNull();

    // El pago llega cobrado (invoice.payment_succeeded) → recuperación.
    await billing.recordStripeInvoiceFromWebhook({
      id: `in_a_${stamp}`,
      customer: cus,
      currency: 'eur',
      status: 'paid',
      amount_paid: 4900,
      lines: { data: [] },
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    } as unknown as Parameters<typeof billing.recordStripeInvoiceFromWebhook>[0]);

    const rowA2 = await admin.tenantSubscriptionPayment.findFirst({
      where: { externalId: `in_a_${stamp}` },
    });
    expect(rowA2!.status).toBe('paid');
    expect(rowA2!.recoveredAt).toBeTruthy();
    expect(rowA2!.failedAttempts).toBe(2); // conserva el histórico de intentos

    // Factura 2 sigue sin recuperar.
    const rowB = await admin.tenantSubscriptionPayment.findFirst({
      where: { externalId: `in_b_${stamp}` },
    });
    expect(rowB!.recoveredAt).toBeNull();

    // El reporte agrega ambos.
    const report = await request(app.getHttpServer())
      .get('/admin/metrics/payment-retries?months=12')
      .set({ Authorization: `Bearer ${token}` });
    expect(report.status).toBe(200);
    expect(report.body.totalFailed).toBeGreaterThanOrEqual(2);
    expect(report.body.recovered).toBeGreaterThanOrEqual(1);
    expect(report.body.stillFailing).toBeGreaterThanOrEqual(1);
    expect(report.body.amountRecovered).toBeGreaterThanOrEqual(49);
    expect(report.body.amountAtRisk).toBeGreaterThanOrEqual(49);
    expect(report.body.recoveryRatePercent).toBeGreaterThan(0);
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/metrics/payment-retries').expect(401);
  });
});
