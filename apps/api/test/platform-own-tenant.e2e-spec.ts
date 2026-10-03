import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ISSUER = {
  legalName: 'TrasterOS SL',
  taxId: 'B12345674',
  address: 'Calle Mayor 1',
  city: 'Madrid',
  postalCode: '28001',
  country: 'ES',
  taxRate: 21,
  seriesPrefix: 'SAAS',
};

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Las facturas de suscripción se emiten como facturas del negocio propio de la
 * sociedad (mismo NIF, misma cadena Veri*Factu y exportación), con cada tenant
 * como su cliente.
 */
describe('Facturas de suscripción emitidas por el negocio propio (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let auth: { Authorization: string };
  const http = () => request(app.getHttpServer());
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    const sa = await seedSuperAdmin('owntenant');
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await admin.platformBillingSettings.updateMany({ data: { ownTenantId: null } });
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('flujo completo', async () => {
    const own = await registerVerifiedUser(app, 'ownissuer');
    const ownAuth = { Authorization: `Bearer ${own.accessToken}` };
    await ensureDefaultSeries(app, own.accessToken);

    // El negocio propio debe ser la misma sociedad que el emisor (mismo NIF).
    await admin.tenant.update({ where: { id: own.tenantId }, data: { taxId: '12345678Z' } });
    const mismatch = await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({ ...ISSUER, enabled: true, ownTenantSlug: own.slug })
      .expect(400);
    expect(mismatch.body.code).toBe('own_tenant_tax_id_mismatch');
    await admin.tenant.update({ where: { id: own.tenantId }, data: { taxId: 'B12345674' } });
    await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({ ...ISSUER, enabled: true, ownTenantSlug: own.slug })
      .expect(200);

    // Un tenant con sus datos de facturación paga su suscripción.
    const client = await registerVerifiedUser(app, 'ownclient');
    await http()
      .post('/settings/saas-billing/billing-details')
      .set({ Authorization: `Bearer ${client.accessToken}` })
      .send({
        legalName: 'Trasteros Cliente SL',
        taxId: 'A58818501',
        address: 'C/ Dos 2',
        city: 'Valencia',
        postalCode: '46001',
      })
      .expect(200);
    await http()
      .post(`/admin/tenants/${client.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'bank_transfer', amount: 121, durationMonths: 1 })
      .expect(201);

    // La factura de suscripción es una factura normal del negocio propio.
    const list = await http()
      .get(`/admin/tenants/${client.tenantId}/platform-invoices`)
      .set(auth)
      .expect(200);
    const sub = list.body[0];
    expect(sub.ownTenantInvoiceId).toBeTruthy();
    const real = await admin.invoice.findUniqueOrThrow({
      where: { id: sub.ownTenantInvoiceId },
      include: { customer: true },
    });
    expect(real).toMatchObject({ tenantId: own.tenantId, status: 'paid' });
    expect(Number(real.total)).toBe(121);
    expect(real.hash).toMatch(/^[0-9A-F]{64}$/); // en la cadena Veri*Factu del negocio propio
    expect(sub.fullNumber).toBe(real.invoiceNumber);
    expect(real.customer).toMatchObject({
      platformTenantId: client.tenantId,
      companyName: 'Trasteros Cliente SL',
      documentNumber: 'A58818501',
    });
    // El tenant la ve en su panel.
    const mine = await http()
      .get('/settings/saas-billing/invoices')
      .set({ Authorization: `Bearer ${client.accessToken}` })
      .expect(200);
    expect(mine.body.map((i: { fullNumber: string }) => i.fullNumber)).toContain(
      real.invoiceNumber,
    );
    // Sin los correos de inquilino del negocio propio («Nueva factura», «Pago recibido»).
    const comms = await admin.communication.count({ where: { invoiceId: real.id } });
    expect(comms).toBe(0);

    // Un segundo pago reutiliza el mismo cliente.
    await http()
      .post(`/admin/tenants/${client.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'cash', amount: 60.5, durationMonths: 1 })
      .expect(201);
    expect(
      await admin.customer.count({
        where: { tenantId: own.tenantId, platformTenantId: client.tenantId },
      }),
    ).toBe(1);

    // No se rectifica desde la plataforma, sino desde el negocio propio…
    const fromPlatform = await http()
      .post(`/admin/platform-invoices/${sub.id}/rectify`)
      .set(auth)
      .send({ method: 'differences', reason: 'Descuento', amount: 60.5 })
      .expect(400);
    expect(fromPlatform.body.code).toBe('rectify_in_own_tenant');
    const rect = await http()
      .post(`/invoices/${real.id}/rectify`)
      .set(ownAuth)
      .send({
        rectificationType: 'R4',
        reason: 'Descuento',
        items: [{ description: 'Descuento', quantity: 1, unitPrice: -50, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${rect.body.id}/issue`).set(ownAuth).expect(200);
    // …y la rectificativa aparece sola en la suscripción del tenant.
    const mirrored = await waitFor(() =>
      admin.platformInvoice.findUnique({ where: { invoiceId: rect.body.id as string } }),
    );
    expect(mirrored).toMatchObject({
      tenantId: client.tenantId,
      rectifiesInvoiceId: sub.id,
      correctionMethod: 'differences',
    });
    expect(Number(mirrored.total)).toBe(-60.5);

    // Exportación para la asesoría: cada factura una sola vez (en el negocio propio).
    const exp = await http()
      .get(`/admin/platform-billing/accountant-export?from=${today}&to=${today}`)
      .set(auth)
      .expect(200);
    const rows = (exp.body.invoices as { invoiceNumber: string; source: string }[]).filter(
      (r) => r.invoiceNumber === real.invoiceNumber,
    );
    expect(rows.map((r) => r.source)).toEqual(['own_business']);
    const pays = (exp.body.payments as { invoiceNumber: string | null; source: string }[]).filter(
      (r) => r.invoiceNumber === real.invoiceNumber,
    );
    expect(pays.map((r) => r.source)).toEqual(['own_business']);
  }, 60_000);
});
