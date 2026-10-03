import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Precios de la plataforma con IVA incluido (por defecto) o +IVA: con +IVA se
 * cobra el precio más el IVA (cobro de extras, resumen, catálogo público).
 */
describe('Precios de la plataforma con IVA incluido o +IVA (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    const sa = await seedSuperAdmin('pricesvat');
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-vat-addon' } });
  });

  afterAll(async () => {
    await admin.platformBillingSettings.updateMany({ data: { pricesIncludeVat: true } });
    await admin.subscriptionAddon.deleteMany({ where: { slug: 'e2e-vat-addon' } });
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('con +IVA se cobra el precio más el IVA', async () => {
    const t = await registerVerifiedUser(app, 'pricesvat');
    const addon = await admin.subscriptionAddon.create({
      data: { slug: 'e2e-vat-addon', name: 'Extra IVA', priceMonthly: 10, isActive: true },
    });
    await http()
      .post(`/admin/tenants/${t.tenantId}/addons`)
      .set(auth)
      .send({ addonId: addon.id, quantity: 1 })
      .expect(201);

    // IVA incluido (por defecto): se cobra el precio tal cual.
    await admin.platformBillingSettings.updateMany({ data: { pricesIncludeVat: true } });
    let today = await http().get('/admin/today').set(auth).expect(200);
    let due = today.body.addonCharges.find((c: { tenantId: string }) => c.tenantId === t.tenantId);
    expect(due.amount).toBe(10);

    // +IVA (se cambia desde los ajustes del emisor).
    const current = await http().get('/admin/platform-billing/settings').set(auth).expect(200);
    const saved = await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({
        legalName: current.body.legalName,
        taxId: current.body.taxId,
        country: current.body.country,
        taxRate: 21,
        seriesPrefix: current.body.seriesPrefix,
        enabled: current.body.enabled,
        pricesIncludeVat: false,
      })
      .expect(200);
    expect(saved.body.pricesIncludeVat).toBe(false);

    today = await http().get('/admin/today').set(auth).expect(200);
    due = today.body.addonCharges.find((c: { tenantId: string }) => c.tenantId === t.tenantId);
    expect(due.amount).toBe(12.1);

    const summary = await http()
      .get(`/admin/tenants/${t.tenantId}/billing-summary`)
      .set(auth)
      .expect(200);
    expect(summary.body.pricesIncludeVat).toBe(false);
    expect(summary.body.effectiveMonthlyToCharge).toBeCloseTo(
      summary.body.effectiveMonthly * 1.21,
      2,
    );

    const plans = await http().get('/subscription-plans').expect(200);
    expect(plans.body[0].pricesIncludeVat).toBe(false);

    // El cobro del extra registra el importe con IVA.
    await http()
      .post(`/admin/today/addon-charges/${due.tenantAddonId}/charge`)
      .set(auth)
      .send({ provider: 'cash' })
      .expect(201);
    const pay = await admin.tenantSubscriptionPayment.findFirstOrThrow({
      where: { tenantId: t.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    expect(Number(pay.amount)).toBe(12.1);
  });
});
