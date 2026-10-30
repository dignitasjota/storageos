import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformDunningService } from '../src/modules/billing-saas/platform-dunning.service';
import { PlatformSepaRemittanceService } from '../src/modules/billing-saas/platform-sepa/platform-sepa-remittance.service';
import { decodeMerchantParameters } from '../src/modules/payments/redsys/redsys-signature';

import { registerVerifiedUser } from './helpers/auth-flow';
import { PLATFORM_CREDITOR_ADDRESS, platformMandateBody } from './helpers/platform-sepa';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-billing-features@storageos.local';
const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const DAY = 86_400_000;

/**
 * Mejoras de Cobros del panel admin: pagar varios meses (y los extras) con
 * tarjeta, recordatorio a demanda, avisos al super admin, remesa SEPA
 * automática y reintentos de Redsys en el calendario.
 */
describe('Admin: mejoras de Cobros (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  const addonSlug = `e2e-billfeat-${Date.now()}`;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Billing Features',
        role: 'superadmin',
      },
    });
    await db.platformRedsysSettings.deleteMany({});
    app = await createTestApp();
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await db.platformRedsysSettings.deleteMany({});
    await db.platformSepaSettings.updateMany({ data: { autoPrepare: false } });
    await app.close();
    await db.subscriptionAddon.deleteMany({ where: { slug: addonSlug } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  async function lateTenant(suffix: string, daysLate: number, mode = 'manual') {
    const owner = await registerVerifiedUser(app, suffix);
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'past_due',
        billingMode: mode,
        stripeSubscriptionId: null,
        currentPeriodEnd: new Date(Date.now() - daysLate * DAY),
        manualExtensionDays: 0,
      },
    });
    return owner;
  }

  it('pagar con tarjeta varios meses de una vez, con los extras en el cobro automático', async () => {
    await http()
      .put('/admin/platform-redsys/settings')
      .set(auth())
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: TEST_KEY,
        environment: 'test',
        enabled: true,
        cardOnFileEnabled: true,
      })
      .expect(200);
    const owner = await lateTenant('billfeatmonths', 70);
    const tAuth = { Authorization: `Bearer ${owner.accessToken}` };

    const options = await http().get('/settings/saas-billing/redsys').set(tAuth).expect(200);
    expect(options.body.available).toBe(true);
    expect(options.body.monthsOwed).toBe(3);
    const monthly = options.body.amount as number;

    const redirect = await http()
      .post('/settings/saas-billing/redsys/redirect')
      .set(tAuth)
      .send({ payMethod: 'card', months: 3 })
      .expect(200);
    const params = decodeMerchantParameters(redirect.body.merchantParameters) as Record<
      string,
      string
    >;
    expect(Number(params.DS_MERCHANT_AMOUNT)).toBe(Math.round(monthly * 100) * 3);
    const order = await db.platformRedsysOrder.findFirstOrThrow({
      where: { tenantId: owner.tenantId, status: 'pending' },
    });
    expect(order.months).toBe(3);

    // Con el cobro automático, el extra de pago a mano va en el mismo cargo.
    const addon = await http()
      .post('/admin/addons')
      .set(auth())
      .send({ slug: addonSlug, name: 'Extra de prueba', priceMonthly: 10 })
      .expect(201);
    await http()
      .post(`/admin/tenants/${owner.tenantId}/addons`)
      .set(auth())
      .send({ addonId: addon.body.id, quantity: 1 })
      .expect(201);
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { billingMode: 'redsys' },
    });
    const withAddon = await http().get('/settings/saas-billing/redsys').set(tAuth).expect(200);
    expect(withAddon.body.amount).toBeGreaterThan(monthly + 9);
  });

  it('recordatorio a demanda y avisos al super admin de impagos y cuentas exentas domiciliadas', async () => {
    const late = await lateTenant('billfeatremind', 20);
    const sent = await http()
      .post(`/admin/billing/receivables/${late.tenantId}/remind`)
      .set(auth())
      .expect(200);
    expect(sent.body.recipients).toBeGreaterThanOrEqual(1);

    const fine = await registerVerifiedUser(app, 'billfeatfine');
    const nope = await http()
      .post(`/admin/billing/receivables/${fine.tenantId}/remind`)
      .set(auth());
    expect(nope.status).toBe(400);
    expect(nope.body.code).toBe('nothing_overdue');

    const exempt = await registerVerifiedUser(app, 'billfeatexempt');
    await db.tenant.update({ where: { id: exempt.tenantId }, data: { billingExempt: true } });
    await db.tenantSubscription.update({
      where: { tenantId: exempt.tenantId },
      data: { billingMode: 'sepa' },
    });

    const dunning = app.get(PlatformDunningService);
    await dunning.notifyBillingAlerts();
    const link = (id: string) => `/admin/tenants/${id}?tab=payments`;
    expect(
      await db.superAdminNotification.count({
        where: { type: 'platform_billing.past_due', link: link(late.tenantId) },
      }),
    ).toBe(1);
    expect(
      await db.superAdminNotification.count({
        where: { type: 'platform_billing.mode_mismatch', link: link(exempt.tenantId) },
      }),
    ).toBe(1);
    // Una sola vez por impago.
    await dunning.notifyBillingAlerts();
    expect(
      await db.superAdminNotification.count({
        where: { type: 'platform_billing.past_due', link: link(late.tenantId) },
      }),
    ).toBe(1);

    // «En riesgo» y «Hoy» llevan lo que debe.
    const risk = await http().get('/admin/tenants/at-risk').set(auth()).expect(200);
    const row = (risk.body.pastDue as { id: string; owedAmount?: number }[]).find(
      (t) => t.id === late.tenantId,
    );
    expect(row?.owedAmount).toBeGreaterThan(0);
  });

  it('el calendario enseña el reintento de un cobro con tarjeta rechazado', async () => {
    const owner = await registerVerifiedUser(app, 'billfeatretry');
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    const end = new Date(Date.now() - DAY);
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { billingMode: 'redsys', status: 'past_due', currentPeriodEnd: end },
    });
    await db.platformRedsysCard.create({
      data: { tenantId: owner.tenantId, identifierEncrypted: 'x', lastError: 'Denegada' },
    });
    await db.platformRedsysOrder.create({
      data: {
        order: `8${Date.now().toString().slice(-11)}`,
        tenantId: owner.tenantId,
        amountCents: 7900,
        status: 'failed',
        kind: 'auto',
        payMethod: 'card',
      },
    });
    const cal = await http().get('/admin/billing/calendar?days=30').set(auth()).expect(200);
    const retry = (
      cal.body.charges as { tenantId: string; state: string; attempt?: number }[]
    ).find((c) => c.tenantId === owner.tenantId);
    expect(retry).toMatchObject({ state: 'retry', attempt: 2 });
  });

  it('la remesa SEPA se prepara sola y avisa si queda sin confirmar', async () => {
    await http()
      .put('/admin/platform-sepa/settings')
      .set(auth())
      .send({
        creditorName: 'TrasterOS SL',
        ...PLATFORM_CREDITOR_ADDRESS,
        creditorId: 'ES98ZZZ12345678',
        creditorIban: 'ES9121000418450200051332',
        creditorBic: 'BBVAESMMXXX',
        enabled: true,
        autoPrepare: true,
      })
      .expect(200);
    const owner = await registerVerifiedUser(app, 'billfeatauto');
    await http()
      .post('/settings/saas-billing/sepa-mandate')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .send(platformMandateBody('ES9121000418450200051332'))
      .expect(200);
    await http()
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(auth())
      .send({ mode: 'sepa' })
      .expect(200);
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { currentPeriodEnd: new Date(Date.now() + 2 * DAY), status: 'active' },
    });

    const service = app.get(PlatformSepaRemittanceService);
    const run = await service.autoPrepare();
    expect(run.prepared).not.toBeNull();
    const list = await http().get('/admin/platform-sepa/remittances').set(auth()).expect(200);
    const rem = (list.body as { id: string; automatic: boolean; itemCount: number }[]).find(
      (r) => r.id === run.prepared,
    );
    expect(rem).toMatchObject({ automatic: true });
    expect(
      await db.platformSepaRemittanceItem.count({
        where: { remittanceId: run.prepared!, tenantId: owner.tenantId },
      }),
    ).toBe(1);

    // Pasada la fecha de cobro sin confirmar, avisa una vez.
    await db.platformSepaRemittance.update({
      where: { id: run.prepared! },
      data: { collectionDate: new Date(Date.now() - 5 * DAY) },
    });
    const later = await service.autoPrepare();
    expect(later.stale).toBeGreaterThanOrEqual(1);
    expect(
      await db.superAdminNotification.count({
        where: {
          type: 'platform_sepa.remittance_unconfirmed',
          link: `/admin/platform-sepa/remittances?id=${run.prepared}`,
        },
      }),
    ).toBe(1);
    await http().post(`/admin/platform-sepa/remittances/${run.prepared}/cancel`).set(auth());
  });
});
