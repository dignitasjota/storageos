import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformDunningService } from '../src/modules/billing-saas/platform-dunning.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-billing-review@storageos.local';
const DAY = 86_400_000;

/**
 * Revisión de Cobros del panel admin: pasar a Free deja de deber, el
 * escalado respeta las suspensiones a mano, la deuda cuenta cada cuota
 * vencida, Stripe cuenta desde el cobro que falló y un cobro de Redsys sin
 * respuesta no es un impago.
 */
describe('Admin: revisión de Cobros (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Billing Review',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
    await request(app.getHttpServer())
      .put('/admin/platform-dunning/settings')
      .set(auth())
      .send({ enabled: true, reminder1Days: 3, reminder2Days: 10, suspendDays: 21 })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  async function lateTenant(suffix: string, daysLate: number) {
    const owner = await registerVerifiedUser(app, suffix);
    const end = new Date(Date.now() - daysLate * DAY);
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'past_due',
        billingMode: 'manual',
        stripeSubscriptionId: null,
        currentPeriodStart: new Date(end.getTime() - 30 * DAY),
        currentPeriodEnd: end,
        manualExtensionDays: 0,
      },
    });
    return owner.tenantId;
  }

  it('pasar a Free deja de deber: fuera de cobros pendientes y del escalado', async () => {
    const tenantId = await lateTenant('billrevfree', 25);
    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/change-plan`)
      .set(auth())
      .send({ planSlug: 'free', reason: 'Impago' })
      .expect(200);
    const sub = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    expect(sub.status).toBe('active');

    await app.get(PlatformDunningService).run();
    expect(await db.platformDunningEvent.count({ where: { tenantId } })).toBe(0);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t.status).toBe('active');
  });

  it('el escalado no toca a un tenant suspendido a mano (motivo y fecha de baja)', async () => {
    const tenantId = await lateTenant('billrevsusp', 25);
    const canceledAt = new Date(Date.now() - 40 * DAY);
    await db.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended', churnReason: 'business_closure', canceledAt },
    });
    await app.get(PlatformDunningService).run();
    const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t.churnReason).toBe('business_closure');
    expect(t.canceledAt?.getTime()).toBe(canceledAt.getTime());
    expect(await db.platformDunningEvent.count({ where: { tenantId } })).toBe(0);
  });

  it('cobros pendientes: una cuota por cada periodo vencido y Stripe desde el cobro que falló', async () => {
    // Manual: vencido hace ~75 días → tres cuotas.
    const manualId = await lateTenant('billrevmonths', 75);
    // Stripe: el periodo empezó hace 5 días (el cobro que falló) y acaba en 25.
    const owner = await registerVerifiedUser(app, 'billrevstripe');
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'past_due',
        billingMode: 'stripe',
        stripeSubscriptionId: `sub_billrev_${Date.now()}`,
        currentPeriodStart: new Date(Date.now() - 5 * DAY),
        currentPeriodEnd: new Date(Date.now() + 25 * DAY),
        manualExtensionDays: 0,
      },
    });

    const res = await request(app.getHttpServer())
      .get('/admin/billing/receivables')
      .set(auth())
      .expect(200);
    type Row = {
      tenantId: string;
      kind: string;
      amount: number;
      days: number;
      overdue: { periods: number; periodAmount: number } | null;
    };
    const manual = (res.body.items as Row[]).find(
      (i) => i.tenantId === manualId && i.kind === 'subscription',
    )!;
    expect(manual.overdue!.periods).toBe(3);
    expect(manual.amount).toBeCloseTo(manual.overdue!.periodAmount * 3, 2);

    const stripe = (res.body.items as Row[]).find(
      (i) => i.tenantId === owner.tenantId && i.kind === 'subscription',
    )!;
    expect(stripe.days).toBe(5);
    expect(stripe.overdue!.periods).toBe(1);
  });

  it('un cobro de Redsys sin respuesta no pasa la cuota a impago', async () => {
    const owner = await registerVerifiedUser(app, 'billrevredsys');
    await db.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } });
    await db.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: {
        status: 'active',
        billingMode: 'redsys',
        stripeSubscriptionId: null,
        currentPeriodEnd: new Date(Date.now() - 2 * 3600 * 1000),
      },
    });
    await db.platformRedsysOrder.create({
      data: {
        order: `9${Date.now().toString().slice(-11)}`,
        tenantId: owner.tenantId,
        amountCents: 7900,
        status: 'charging',
        kind: 'auto',
        payMethod: 'card',
      },
    });
    await app.get(PlatformDunningService).markLapsedManualPastDue();
    const sub = await db.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: owner.tenantId },
    });
    expect(sub.status).toBe('active');
  });
});
