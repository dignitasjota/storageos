import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-smp-test@storageos.local';

describe('Admin SaaS manual payment (e2e)', () => {
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
        fullName: 'Admin SMP Test',
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

  it('registra un pago manual, extiende el periodo y soporta descuento', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp');

    const before = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    const periodEndBefore = new Date(before.body.subscription.currentPeriodEnd).getTime();

    // Pago manual por transferencia, 2 meses
    const created = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'bank_transfer', amount: 58, durationMonths: 2 });
    expect(created.status).toBe(201);
    expect(created.body.provider).toBe('bank_transfer');
    expect(created.body.status).toBe('paid');
    expect(created.body.amount).toBe(58);
    const newPeriodEnd = new Date(created.body.periodEnd).getTime();
    expect(newPeriodEnd).toBeGreaterThan(periodEndBefore);

    // El detalle del tenant refleja el periodo extendido + status active
    const after = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(new Date(after.body.subscription.currentPeriodEnd).getTime()).toBe(newPeriodEnd);
    expect(after.body.subscription.status).toBe('active');

    // Aparece en el historial
    const list = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/saas-payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].provider).toBe('bank_transfer');
    expect(list.body[0].discount).toBeNull();

    // Segundo pago en efectivo con descuento, 1 mes → extiende desde el nuevo fin
    const withDiscount = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 20, discount: 9, durationMonths: 1 });
    expect(withDiscount.status).toBe(201);
    expect(withDiscount.body.discount).toBe(9);
    expect(new Date(withDiscount.body.periodEnd).getTime()).toBeGreaterThan(newPeriodEnd);

    // Validación: importe negativo -> 400
    const bad = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'other', amount: -5, durationMonths: 1 });
    expect(bad.status).toBe(400);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .send({ provider: 'cash', amount: 10, durationMonths: 1 });
    expect(noAuth.status).toBe(401);
  });

  it('el crédito manual se SUMA al periodo de Stripe (acumulador permanente)', async () => {
    const owner = await registerVerifiedUser(app, 'admin-smp-acc');

    // Pago manual de 1 mes → acumula sus días en manual_extension_days
    const manual = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 29, durationMonths: 1 });
    expect(manual.status).toBe(201);

    const sub = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    const manualDays = sub?.manualExtensionDays ?? 0;
    expect(manualDays).toBeGreaterThanOrEqual(28);

    // Simula un webhook de Stripe que fija el periodo a "ahora + 90 días".
    const svc = app.get(BillingSaasService, { strict: false });
    const nowSec = Math.floor(Date.now() / 1000);
    const stripeEndSec = nowSec + 90 * 24 * 3600;
    await svc.syncSubscriptionFromStripe({
      stripeSubscriptionId: `sub_acc_${Date.now()}`,
      stripeCustomerId: `cus_acc_${Date.now()}`,
      tenantIdHint: owner.tenantId,
      status: 'active',
      currentPeriodStart: nowSec,
      currentPeriodEnd: stripeEndSec,
      cancelAtPeriodEnd: false,
    });

    // El periodo efectivo = fecha de Stripe + los días manuales (no se pisa).
    const after = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    const expectedEndMs = stripeEndSec * 1000 + manualDays * 24 * 3600 * 1000;
    expect(Math.abs((after?.currentPeriodEnd.getTime() ?? 0) - expectedEndMs)).toBeLessThan(1000);
    // El acumulador no se toca en el webhook (crédito permanente).
    expect(after?.manualExtensionDays).toBe(manualDays);
  });
});
