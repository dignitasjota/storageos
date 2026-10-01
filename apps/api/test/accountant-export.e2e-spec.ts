import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
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

/**
 * Datos obligatorios de las facturas de suscripción y exportación para la
 * asesoría (suscripciones + negocio propio de la SL juntos).
 */
describe('Datos fiscales y exportación para la asesoría (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let auth: { Authorization: string };
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    const sa = await seedSuperAdmin('acctexp');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await admin.superAdminNotification.deleteMany({
      where: { type: 'platform_invoice.incomplete_recipient' },
    });
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('flujo completo', async () => {
    const http = () => request(app.getHttpServer());

    // El emisor no puede activar la facturación con datos incompletos.
    const incomplete = await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({ ...ISSUER, address: '', enabled: true })
      .expect(400);
    expect(incomplete.body.code).toBe('platform_billing_incomplete');
    const ok = await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({ ...ISSUER, enabled: true })
      .expect(200);
    expect(ok.body.missing).toEqual([]);

    // El tenant completa sus datos de facturación desde su panel.
    const a = await registerVerifiedUser(app, 'acctexpa');
    const aAuth = { Authorization: `Bearer ${a.accessToken}` };
    const before = await http()
      .get('/settings/saas-billing/billing-details')
      .set(aAuth)
      .expect(200);
    expect(before.body.missing).toEqual(
      expect.arrayContaining(['Razón social', 'NIF', 'Dirección']),
    );
    await http()
      .post('/settings/saas-billing/billing-details')
      .set(aAuth)
      .send({
        legalName: 'Trasteros A SL',
        taxId: 'B12345675',
        address: 'C/ Uno 1',
        city: 'Sevilla',
        postalCode: '41001',
      })
      .expect(400);
    const saved = await http()
      .post('/settings/saas-billing/billing-details')
      .set(aAuth)
      .send({
        legalName: 'Trasteros A SL',
        taxId: 'b-1234567 4',
        address: 'C/ Uno 1',
        city: 'Sevilla',
        postalCode: '41001',
      })
      .expect(200);
    expect(saved.body).toMatchObject({ taxId: 'B12345674', missing: [] });

    // Su factura de suscripción lleva razón social y domicilio.
    await http()
      .post(`/admin/tenants/${a.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'bank_transfer', amount: 121, durationMonths: 1 })
      .expect(201);
    const aInv = await http().get(`/admin/tenants/${a.tenantId}/platform-invoices`).set(auth);
    expect(aInv.body[0]).toMatchObject({ tenantName: 'Trasteros A SL', missing: [] });

    // Un tenant sin datos: la factura se emite pero queda marcada y se avisa.
    const b = await registerVerifiedUser(app, 'acctexpb');
    await http()
      .post(`/admin/tenants/${b.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'cash', amount: 60.5, durationMonths: 1 })
      .expect(201);
    const bInv = await http().get(`/admin/tenants/${b.tenantId}/platform-invoices`).set(auth);
    expect(bInv.body[0].missing).toEqual(['NIF', 'Domicilio']);
    const notif = await admin.superAdminNotification.findFirst({
      where: {
        type: 'platform_invoice.incomplete_recipient',
        link: `/admin/tenants/${b.tenantId}`,
      },
    });
    expect(notif).not.toBeNull();

    // Negocio propio de la SL: una factura cobrada a un inquilino.
    const own = await registerVerifiedUser(app, 'acctexpown');
    const ownAuth = { Authorization: `Bearer ${own.accessToken}` };
    const customerId = await createCustomer(app, own.accessToken, { documentNumber: '12345678Z' });
    const ownInv = await createDraftInvoice(app, own.accessToken, customerId);
    const issued = await http().post(`/invoices/${ownInv}/issue`).set(ownAuth).expect(200);
    await http()
      .post(`/invoices/${ownInv}/mark-paid`)
      .set(ownAuth)
      .send({ amount: 121, methodType: 'bank_transfer' })
      .expect(200);

    await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({ ...ISSUER, enabled: true, ownTenantSlug: 'no-existe-xyz' })
      .expect(400);
    const withOwn = await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({ ...ISSUER, enabled: true, ownTenantSlug: own.slug })
      .expect(200);
    expect(withOwn.body.ownTenant).toMatchObject({ id: own.tenantId });

    // Vista previa: las dos actividades, cobros y avisos.
    const exp = await http()
      .get(`/admin/platform-billing/accountant-export?from=${today}&to=${today}`)
      .set(auth)
      .expect(200);
    const invNumbers = (exp.body.invoices as { invoiceNumber: string; source: string }[]).map(
      (r) => `${r.source}:${r.invoiceNumber}`,
    );
    expect(invNumbers).toContain(`subscriptions:${aInv.body[0].fullNumber}`);
    expect(invNumbers).toContain(`own_business:${issued.body.invoiceNumber}`);
    const ownRow = (exp.body.invoices as Record<string, unknown>[]).find(
      (r) => r.invoiceNumber === issued.body.invoiceNumber,
    );
    expect(ownRow).toMatchObject({ customerNif: '12345678Z', base: 100, vat: 21, taxRate: 21 });
    const pays = exp.body.payments as { source: string; invoiceNumber: string; method: string }[];
    expect(pays).toContainEqual(
      expect.objectContaining({
        source: 'own_business',
        invoiceNumber: issued.body.invoiceNumber,
        method: 'Transferencia',
      }),
    );
    expect(pays).toContainEqual(
      expect.objectContaining({ source: 'subscriptions', invoiceNumber: aInv.body[0].fullNumber }),
    );
    expect(exp.body.warnings).toContainEqual(
      expect.objectContaining({
        invoiceNumber: bInv.body[0].fullNumber,
        missing: ['NIF', 'Domicilio'],
      }),
    );

    // CSV (coma decimal) y Excel.
    const csv = await http()
      .get(`/admin/platform-billing/accountant-export?from=${today}&to=${today}&format=csv`)
      .set(auth)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Actividad;Nº factura;Fecha;Tipo');
    expect(csv.text).toContain('Negocio propio');
    expect(csv.text).toContain('100,00');
    const csvPays = await http()
      .get(
        `/admin/platform-billing/accountant-export?from=${today}&to=${today}&format=csv&kind=payments`,
      )
      .set(auth)
      .expect(200);
    expect(csvPays.text).toContain('Forma de cobro');
    const xlsx = await http()
      .get(`/admin/platform-billing/accountant-export?from=${today}&to=${today}&format=xlsx`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    await http().get('/admin/platform-billing/accountant-export').set(auth).expect(400);
  }, 90_000);
});
