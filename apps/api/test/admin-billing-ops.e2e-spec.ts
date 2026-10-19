import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-bo-test@storageos.local';

describe('Admin: cuenta, cobros pendientes y calendario (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin BO Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function setupTenant(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const tenant = await adminClient.tenant.findUniqueOrThrow({
      where: { slug: owner.slug },
      include: { subscription: { include: { plan: true } } },
    });
    await adminClient.tenant.update({ where: { id: tenant.id }, data: { status: 'active' } });
    return { tenant, plan: tenant.subscription!.plan };
  }
  const DAY = 86_400_000;

  it('estado de cuenta y cobros pendientes: cuota impagada con su escalado y un extra aparte', async () => {
    const { tenant, plan } = await setupTenant('adminbo');
    const periodEnd = new Date(Date.now() - 5 * DAY);
    await adminClient.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: {
        status: 'past_due',
        billingMode: 'manual',
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
        currentPeriodEnd: periodEnd,
      },
    });
    const addon = await adminClient.subscriptionAddon.upsert({
      where: { slug: 'e2e-bo-addon' },
      update: {},
      create: { slug: 'e2e-bo-addon', name: 'Extra BO', priceMonthly: 10 },
    });
    await adminClient.tenantSubscriptionAddon.create({
      data: {
        tenantId: tenant.id,
        addonId: addon.id,
        priceMonthly: 10,
        billingMode: 'manual',
        nextChargeAt: new Date(Date.now() - DAY),
      },
    });
    const settings = await adminClient.platformDunningSettings.findFirst();
    if (settings) {
      await adminClient.platformDunningSettings.update({
        where: { id: settings.id },
        data: { enabled: true, reminder1Days: 1, reminder2Days: 7, suspendDays: 14 },
      });
    } else {
      await adminClient.platformDunningSettings.create({
        data: { enabled: true, reminder1Days: 1, reminder2Days: 7, suspendDays: 14 },
      });
    }
    await adminClient.platformDunningEvent.create({
      data: { tenantId: tenant.id, step: 'reminder_1', periodEnd },
    });
    await adminClient.tenantSubscriptionPayment.create({
      data: {
        tenantId: tenant.id,
        provider: 'manual',
        status: 'paid',
        amount: 50,
        paidAt: new Date(Date.now() - 40 * DAY),
      },
    });
    const auth = { Authorization: `Bearer ${token}` };

    const account = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenant.id}/account`)
      .set(auth)
      .expect(200);
    expect(account.body.billingMode).toBe('manual');
    expect(account.body.cycle).toBe('monthly');
    expect(account.body.overdue.days).toBe(5);
    expect(account.body.overdue.steps.map((s: { doneAt: string | null }) => !!s.doneAt)).toEqual([
      true,
      false,
      false,
    ]);
    expect(account.body.addonCharges).toHaveLength(1);
    expect(account.body.paid12m).toBe(50);
    expect(account.body.history[0].kind).toBe('payment');

    const rec = await request(app.getHttpServer())
      .get('/admin/billing/receivables')
      .set(auth)
      .expect(200);
    const mine = rec.body.items.filter((i: { tenantId: string }) => i.tenantId === tenant.id);
    expect(mine.map((i: { kind: string }) => i.kind).sort()).toEqual(['addon', 'subscription']);
    const sub = mine.find((i: { kind: string }) => i.kind === 'subscription');
    expect(sub.amount).toBeGreaterThanOrEqual(Number(plan.priceMonthly));

    await adminClient.platformDunningSettings.updateMany({ data: { enabled: false } });
    await adminClient.tenantSubscriptionAddon.deleteMany({ where: { addonId: addon.id } });
    await adminClient.subscriptionAddon.delete({ where: { id: addon.id } });
  });

  it('calendario: el próximo cobro de la cuota y lo cobrado en los últimos días', async () => {
    const { tenant } = await setupTenant('adminbocal');
    const periodEnd = new Date(Date.now() + 10 * DAY);
    await adminClient.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: {
        status: 'active',
        billingMode: 'sepa',
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
        currentPeriodEnd: periodEnd,
      },
    });
    await adminClient.tenantSubscriptionPayment.create({
      data: {
        tenantId: tenant.id,
        provider: 'sepa',
        status: 'paid',
        amount: 79,
        paidAt: new Date(Date.now() - 2 * DAY),
      },
    });
    const cal = await request(app.getHttpServer())
      .get('/admin/billing/calendar?days=30&pastDays=7')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const mine = cal.body.charges.filter((c: { tenantId: string }) => c.tenantId === tenant.id);
    expect(mine.map((c: { state: string }) => c.state)).toEqual(['paid', 'scheduled']);
    expect(mine[1].method).toBe('sepa');
    expect(cal.body.scheduledByMethod.sepa).toBeGreaterThan(0);

    await request(app.getHttpServer()).get('/admin/billing/calendar').expect(401);
  });
});
