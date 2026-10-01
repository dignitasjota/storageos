import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

type Inv = {
  id: string;
  fullNumber: string;
  invoiceType: string;
  status: string;
  total: number;
  baseAmount: number;
  tenantName: string;
  missing: string[];
  rectifies: { id: string; fullNumber: string } | null;
  correctionMethod: string | null;
  rectifiedBy: { fullNumber: string }[];
};

/**
 * Rectificativas de las facturas de suscripción: sustitución (corrige los datos
 * del cliente) y abonos parciales o totales, en su propia serie.
 */
describe('Rectificativas de facturas de suscripción (e2e)', () => {
  let app: INestApplication;
  let auth: { Authorization: string };

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    const sa = await seedSuperAdmin('platrect');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
    await request(app.getHttpServer())
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({
        legalName: 'TrasterOS SL',
        taxId: 'B12345674',
        address: 'Calle Mayor 1',
        city: 'Madrid',
        postalCode: '28001',
        seriesPrefix: 'SAAS',
        enabled: true,
      })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('sustitución y abonos', async () => {
    const http = () => request(app.getHttpServer());
    const t = await registerVerifiedUser(app, 'platrecta');
    const tAuth = { Authorization: `Bearer ${t.accessToken}` };
    const invoices = async (): Promise<Inv[]> =>
      (await http().get(`/admin/tenants/${t.tenantId}/platform-invoices`).set(auth)).body as Inv[];

    // Factura emitida sin datos del cliente.
    await http()
      .post(`/admin/tenants/${t.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'bank_transfer', amount: 121, durationMonths: 1 })
      .expect(201);
    const [first] = await invoices();
    expect(first!.missing).toEqual(['NIF', 'Domicilio']);
    const rectify = (id: string, body: Record<string, unknown>) =>
      http().post(`/admin/platform-invoices/${id}/rectify`).set(auth).send(body);

    // Sustituir sin que el tenant tenga datos → 400.
    const noData = await rectify(first!.id, { method: 'substitution', reason: 'Faltaban datos' });
    expect(noData.status).toBe(400);
    expect(noData.body.code).toBe('tenant_billing_incomplete');

    // El tenant completa sus datos y se sustituye la factura.
    await http()
      .post('/settings/saas-billing/billing-details')
      .set(tAuth)
      .send({
        legalName: 'Trasteros Rect SL',
        taxId: 'B12345674',
        address: 'C/ Dos 2',
        city: 'Valencia',
        postalCode: '46001',
      })
      .expect(200);
    const sub = await rectify(first!.id, { method: 'substitution', reason: 'Faltaban datos' });
    expect(sub.status).toBe(201);
    const subInv = sub.body as Inv;
    expect(subInv.fullNumber).toMatch(/^SAAS-R-\d{4}-\d{4}$/);
    expect(subInv).toMatchObject({
      invoiceType: 'R4',
      correctionMethod: 'substitution',
      total: 121,
      tenantName: 'Trasteros Rect SL',
      missing: [],
      rectifies: { id: first!.id, fullNumber: first!.fullNumber },
    });
    const afterSub = (await invoices()).find((i) => i.id === first!.id)!;
    expect(afterSub.status).toBe('rectified');
    expect(afterSub.rectifiedBy.map((r) => r.fullNumber)).toEqual([subInv.fullNumber]);
    expect(
      (await rectify(first!.id, { method: 'substitution', reason: 'Otra vez' })).body.code,
    ).toBe('invoice_already_substituted');
    expect((await rectify(subInv.id, { method: 'differences', reason: 'No vale' })).body.code).toBe(
      'invoice_not_rectifiable',
    );

    // Abonos sobre otra factura: parcial, exceso, resto y ya anulada.
    await http()
      .post(`/admin/tenants/${t.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'cash', amount: 60.5, durationMonths: 1 })
      .expect(201);
    const second = (await invoices()).find((i) => i.invoiceType === 'F1' && i.total === 60.5)!;
    const partial = await rectify(second.id, {
      method: 'differences',
      reason: 'Descuento acordado',
      amount: 20,
    });
    expect(partial.status).toBe(201);
    expect(partial.body).toMatchObject({ total: -20, correctionMethod: 'differences' });
    expect((partial.body as Inv).baseAmount).toBeLessThan(0);
    const tooMuch = await rectify(second.id, {
      method: 'differences',
      reason: 'Exceso',
      amount: 50,
    });
    expect(tooMuch.body.code).toBe('credit_exceeds_invoice');
    const rest = await rectify(second.id, { method: 'differences', reason: 'Baja' });
    expect(rest.body.total).toBe(-40.5);
    expect((await invoices()).find((i) => i.id === second.id)!.status).toBe('cancelled');
    expect(
      (await rectify(second.id, { method: 'differences', reason: 'Otra más' })).body.code,
    ).toBe('invoice_already_cancelled');

    // El tenant ve sus rectificativas.
    const own = await http().get('/settings/saas-billing/invoices').set(tAuth).expect(200);
    expect((own.body as Inv[]).filter((i) => i.invoiceType === 'R4')).toHaveLength(3);

    // La exportación para la asesoría las incluye con su factura rectificada.
    const today = new Date().toISOString().slice(0, 10);
    const exp = await http()
      .get(`/admin/platform-billing/accountant-export?from=${today}&to=${today}`)
      .set(auth)
      .expect(200);
    expect(exp.body.invoices).toContainEqual(
      expect.objectContaining({
        invoiceNumber: subInv.fullNumber,
        invoiceType: 'R4',
        rectifies: first!.fullNumber,
      }),
    );
  }, 90_000);
});
