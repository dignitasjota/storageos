import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingSaasService } from '../src/modules/billing-saas/billing-saas.service';
import { PlatformInvoicesService } from '../src/modules/billing-saas/platform-invoices.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-pinv-test@storageos.local';

/** Export contable: listado global de facturas SaaS con filtro de fechas. */
describe('Export de facturas SaaS (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin PInv',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  const bearer = () => ({ Authorization: `Bearer ${adminToken}` });

  it('lista todas las facturas SaaS emitidas (cross-tenant)', async () => {
    const owner = await registerVerifiedUser(app, 'pinv-export');
    const tenant = await admin.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Activar la facturación del SaaS + emisor con datos fiscales.
    await request(app.getHttpServer())
      .put('/admin/platform-billing/settings')
      .set(bearer())
      .send({
        legalName: 'TrasterOS SL',
        taxId: 'B12345678',
        country: 'ES',
        taxRate: 21,
        seriesPrefix: 'SAAS',
        enabled: true,
      })
      .expect(200);

    // Registrar un pago manual → genera la factura SaaS.
    const billing = app.get(BillingSaasService, { strict: false });
    const payment = await billing.recordManualPayment({
      tenantId,
      provider: 'bank_transfer',
      amount: 49,
      currency: 'EUR',
      durationMonths: 1,
      extendsPeriod: true,
    });
    const invoices = app.get(PlatformInvoicesService, { strict: false });
    await invoices.issueForPayment(payment.id);

    // El listado global la incluye.
    const all = await request(app.getHttpServer()).get('/admin/platform-invoices').set(bearer());
    expect(all.status).toBe(200);
    const mine = all.body.find((i: { tenantId: string }) => i.tenantId === tenantId);
    expect(mine).toBeTruthy();
    expect(mine.total).toBeGreaterThan(0);
    expect(mine.tenantName).toBeTruthy();
    expect(mine.fullNumber).toContain('SAAS');
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/platform-invoices').expect(401);
  });
});
