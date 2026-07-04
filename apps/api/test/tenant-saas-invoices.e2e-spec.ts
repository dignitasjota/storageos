import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { PlatformInvoicesService } from '../src/modules/billing-saas/platform-invoices.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * El tenant ve/descarga SUS facturas de plataforma (las que le emite StorageOS)
 * y su historial de pagos SaaS, sin ver las de otros tenants.
 */
describe('Facturas SaaS del tenant (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('lista facturas + pagos propios y no ve los de otro tenant', async () => {
    const a = await registerVerifiedUser(app, 'saas-inv-a');
    const b = await registerVerifiedUser(app, 'saas-inv-b');
    const authA = { Authorization: `Bearer ${a.accessToken}` };
    const authB = { Authorization: `Bearer ${b.accessToken}` };
    const stamp = Date.now();

    // Pago + factura de plataforma para el tenant A (insertados directamente).
    const payment = await admin.tenantSubscriptionPayment.create({
      data: {
        tenantId: a.tenantId,
        provider: 'stripe',
        externalId: `in_saas_${stamp}`,
        status: 'paid',
        amount: 49,
        currency: 'EUR',
        planSlug: 'starter',
        planName: 'Starter',
        paidAt: new Date(),
      },
    });
    const invoice = await admin.platformInvoice.create({
      data: {
        series: '2026',
        number: 1,
        fullNumber: `SO-2026-TEST-${stamp}`,
        tenantId: a.tenantId,
        tenantName: 'Tenant A',
        baseAmount: 40.5,
        taxRate: 21,
        taxAmount: 8.5,
        total: 49,
        currency: 'EUR',
        paymentId: payment.id,
      },
    });

    // A ve su factura y su pago.
    const invA = await request(app.getHttpServer())
      .get('/settings/saas-billing/invoices')
      .set(authA);
    expect(invA.status).toBe(200);
    expect(invA.body.some((f: { id: string }) => f.id === invoice.id)).toBe(true);

    const payA = await request(app.getHttpServer())
      .get('/settings/saas-billing/payments')
      .set(authA);
    expect(payA.status).toBe(200);
    expect(payA.body.some((p: { id: string }) => p.id === payment.id)).toBe(true);

    // B NO ve la factura de A.
    const invB = await request(app.getHttpServer())
      .get('/settings/saas-billing/invoices')
      .set(authB);
    expect(invB.body.some((f: { id: string }) => f.id === invoice.id)).toBe(false);

    // B no puede pedir el PDF de una factura de A → 404 (no filtra existencia).
    const pdfB = await request(app.getHttpServer())
      .get(`/settings/saas-billing/invoices/${invoice.id}/pdf`)
      .set(authB);
    expect(pdfB.status).toBe(404);

    // La factura de A sin PDF generado → 404 pdf_not_available (scoping OK).
    const pdfA = await request(app.getHttpServer())
      .get(`/settings/saas-billing/invoices/${invoice.id}/pdf`)
      .set(authA);
    expect(pdfA.status).toBe(404);
    expect(pdfA.body.code).toBe('pdf_not_available');
  });

  it('la factura de un cobro de add-on lleva su concepto real (no «Suscripción»)', async () => {
    const a = await registerVerifiedUser(app, 'saas-inv-concept');
    const auth = { Authorization: `Bearer ${a.accessToken}` };
    const stamp = Date.now();

    // Habilita la facturación de plataforma (necesaria para emitir factura).
    const settings = await admin.platformBillingSettings.findFirst();
    if (settings) {
      await admin.platformBillingSettings.update({
        where: { id: settings.id },
        data: { enabled: true, legalName: 'StorageOS SL' },
      });
    } else {
      await admin.platformBillingSettings.create({
        data: { enabled: true, legalName: 'StorageOS SL' },
      });
    }

    // Pago de un add-on (con `description`) → emitir su factura.
    const payment = await admin.tenantSubscriptionPayment.create({
      data: {
        tenantId: a.tenantId,
        provider: 'cash',
        externalId: `addon_${stamp}`,
        status: 'paid',
        amount: 12,
        currency: 'EUR',
        description: 'Add-on: Asistente IA',
        paidAt: new Date(),
      },
    });
    const svc = app.get(PlatformInvoicesService, { strict: false });
    await svc.issueForPayment(payment.id);

    const inv = await request(app.getHttpServer()).get('/settings/saas-billing/invoices').set(auth);
    const row = inv.body.find((f: { paymentId: string }) => f.paymentId === payment.id);
    expect(row).toBeTruthy();
    expect(row.concept).toBe('Add-on: Asistente IA');
    expect(row.concept).not.toMatch(/Suscripción/);
  });

  it('sin sesión → 401', async () => {
    await request(app.getHttpServer()).get('/settings/saas-billing/invoices').expect(401);
  });
});
