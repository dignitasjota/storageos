import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Facturación del SaaS: al registrar un pago manual con la facturación activada,
 * se emite una factura de suscripción (numerada, con IVA), y se puede emitir
 * manualmente si estaba desactivada. Idempotente por pago.
 */
describe('Facturación del SaaS (e2e)', () => {
  let app: INestApplication;
  let auth: { Authorization: string };
  let tenantId: string;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();

    const owner = await registerVerifiedUser(app, 'saasinv');
    tenantId = owner.tenantId;

    const admin = await seedSuperAdmin('saasinv');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('emite factura con IVA al registrar un pago (idempotente)', async () => {
    // Config del emisor + activar la facturación.
    await request(app.getHttpServer())
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({
        legalName: 'TrasterOS SL',
        taxId: 'B12345678',
        country: 'ES',
        taxRate: 21,
        seriesPrefix: 'SAAS',
        enabled: true,
      })
      .expect(200);

    // Pago manual de 121€ (IVA incluido) → dispara la emisión automática.
    const pay = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'bank_transfer', amount: 121, durationMonths: 1 });
    expect(pay.status).toBe(201);

    // La factura del tenant existe: base 100, IVA 21, total 121.
    const invoices = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/platform-invoices`)
      .set(auth);
    expect(invoices.status).toBe(200);
    expect(invoices.body.length).toBe(1);
    const inv = invoices.body[0];
    expect(inv.fullNumber).toMatch(/^SAAS-\d{4}-0001$/);
    expect(inv.baseAmount).toBe(100);
    expect(inv.taxAmount).toBe(21);
    expect(inv.total).toBe(121);
    expect(inv.paymentId).toBeTruthy();

    // Reemitir el mismo pago es idempotente (no crea otra).
    const reissue = await request(app.getHttpServer())
      .post('/admin/platform-invoices/issue')
      .set(auth)
      .send({ paymentId: inv.paymentId });
    expect(reissue.status).toBe(201);
    expect(reissue.body.fullNumber).toBe(inv.fullNumber);

    const after = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/platform-invoices`)
      .set(auth);
    expect(after.body.length).toBe(1);
  });

  it('sin facturación activada no emite pero se puede emitir a mano', async () => {
    await request(app.getHttpServer())
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({ legalName: 'TrasterOS SL', taxId: 'B1', enabled: false })
      .expect(200);

    const pay = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'cash', amount: 60.5, durationMonths: 1 })
      .expect(201);

    // Emisión manual falla con facturación desactivada.
    const manual = await request(app.getHttpServer())
      .post('/admin/platform-invoices/issue')
      .set(auth)
      .send({ paymentId: pay.body.id });
    expect(manual.status).toBe(400);
    expect(manual.body.code).toBe('platform_billing_disabled');
  });
});
