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

const ADMIN_EMAIL = 'admin-coupons-test@storageos.local';

describe('Admin platform coupons + batch trial extension (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;
  const createdCodes: string[] = [];

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Coupons Test',
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
    await adminClient.platformCoupon.deleteMany({ where: { code: { in: createdCodes } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('aplica un cupón percentage 10% al pago manual e incrementa el uso', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-pct');
    const code = `PCT10-${Date.now()}`;
    createdCodes.push(code);

    // Crea el cupón (10%)
    const created = await request(app.getHttpServer())
      .post('/admin/coupons')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, discountType: 'percentage', discountValue: 10 });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe(code.toUpperCase());
    expect(created.body.usedCount).toBe(0);

    // Registra un pago manual de 100 con el cupón → descuento 10
    const payment = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'bank_transfer', amount: 100, durationMonths: 1, couponCode: code });
    expect(payment.status).toBe(201);
    expect(payment.body.discount).toBe(10);

    // El uso del cupón subió a 1
    const list = await request(app.getHttpServer())
      .get('/admin/coupons')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const found = list.body.find((c: { code: string }) => c.code === code.toUpperCase());
    expect(found.usedCount).toBe(1);
  });

  it('un cupón max_uses:1 da 400 coupon_exhausted al segundo uso', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-once');
    const code = `ONCE-${Date.now()}`;
    createdCodes.push(code);

    const created = await request(app.getHttpServer())
      .post('/admin/coupons')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, discountType: 'fixed', discountValue: 5, maxUses: 1 });
    expect(created.status).toBe(201);
    expect(created.body.maxUses).toBe(1);

    // Primer uso: OK (descuento fijo 5)
    const first = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 40, durationMonths: 1, couponCode: code });
    expect(first.status).toBe(201);
    expect(first.body.discount).toBe(5);

    // Segundo uso (otro tenant, distinto importe para no chocar con la dedup): 400
    const owner2 = await registerVerifiedUser(app, 'coupon-once2');
    const second = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner2.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 41, durationMonths: 1, couponCode: code });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('coupon_exhausted');
  });

  it('un cupón inexistente da 400 coupon_invalid', async () => {
    const owner = await registerVerifiedUser(app, 'coupon-bad');
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/saas-payments/manual`)
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'cash', amount: 30, durationMonths: 1, couponCode: 'NO-EXISTE-XYZ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('coupon_invalid');
  });

  it('extiende el trial de varios tenants a la vez (por lote)', async () => {
    const a = await registerVerifiedUser(app, 'coupon-batch-a');
    const b = await registerVerifiedUser(app, 'coupon-batch-b');

    const beforeA = await adminClient.tenant.findUnique({ where: { id: a.tenantId } });
    const beforeB = await adminClient.tenant.findUnique({ where: { id: b.tenantId } });
    const beforeAms = beforeA?.trialEndsAt?.getTime() ?? 0;
    const beforeBms = beforeB?.trialEndsAt?.getTime() ?? 0;

    const res = await request(app.getHttpServer())
      .post('/admin/tenants/extend-trials')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantIds: [a.tenantId, b.tenantId], days: 10 });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const afterA = await adminClient.tenant.findUnique({ where: { id: a.tenantId } });
    const afterB = await adminClient.tenant.findUnique({ where: { id: b.tenantId } });
    expect(afterA?.trialEndsAt?.getTime() ?? 0).toBeGreaterThan(beforeAms);
    expect(afterB?.trialEndsAt?.getTime() ?? 0).toBeGreaterThan(beforeBms);
    // ~10 días de extensión sobre la base.
    expect((afterA?.trialEndsAt?.getTime() ?? 0) - beforeAms).toBeGreaterThanOrEqual(
      9 * 24 * 3600 * 1000,
    );
  });

  it('sin token -> 401 en la gestión de cupones', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/coupons')
      .send({ code: 'NOAUTH', discountType: 'percentage', discountValue: 5 });
    expect(res.status).toBe(401);
  });
});
