import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { fakeHolded } from './helpers/fake-holded';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Copia en Holded de las facturas de suscripción de la plataforma: desactivada
 * por defecto, serie «No enviar a Verifactu» obligatoria, factura aprobada con
 * su cobro, y «Enviar pendientes» para las emitidas antes de activarla.
 */
describe('Holded de la plataforma: facturas de suscripción (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let holded: Awaited<ReturnType<typeof fakeHolded>>;
  let auth: { Authorization: string };

  beforeAll(async () => {
    holded = await fakeHolded();
    process.env.HOLDED_API_BASE = holded.base;
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    const sa = await seedSuperAdmin('platholded');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    // Deja la copia apagada para no afectar a otras suites.
    await admin.platformBillingSettings.updateMany({
      data: { holdedEnabled: false, holdedApiKeyEncrypted: null, holdedInvoiceSeriesId: null },
    });
    await app.close();
    delete process.env.HOLDED_API_BASE;
    holded.server.close();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('flujo completo', async () => {
    const http = () => request(app.getHttpServer());
    await admin.platformBillingSettings.updateMany({
      data: { holdedEnabled: false, holdedApiKeyEncrypted: null, holdedInvoiceSeriesId: null },
    });

    // Facturación activa; Holded todavía apagado.
    await http()
      .put('/admin/platform-billing/settings')
      .set(auth)
      .send({
        legalName: 'TrasterOS SL',
        taxId: 'B12345674',
        address: 'Calle Mayor 1',
        city: 'Madrid',
        postalCode: '28001',
        enabled: true,
      })
      .expect(200);
    const off = await http().get('/admin/platform-billing/holded').set(auth).expect(200);
    expect(off.body).toMatchObject({ enabled: false, hasApiKey: false, ready: false });

    // Una factura emitida antes de activar Holded no se copia.
    const t = await registerVerifiedUser(app, 'platholdeda');
    await http()
      .post(`/admin/tenants/${t.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'bank_transfer', amount: 121, durationMonths: 1 })
      .expect(201);
    expect(holded.calls.some((c) => c.path === '/invoices')).toBe(false);

    await http()
      .put('/admin/platform-billing/holded')
      .set(auth)
      .send({ enabled: true })
      .expect(400);
    await http()
      .put('/admin/platform-billing/holded')
      .set(auth)
      .send({ apiKey: 'pat_platform_123456', enabled: true })
      .expect(200);
    const series = await http().get('/admin/platform-billing/holded/series').set(auth).expect(200);
    expect(series.body.invoice).toHaveLength(2);
    const bad = await http()
      .put('/admin/platform-billing/holded')
      .set(auth)
      .send({ enabled: true, invoiceSeriesId: 'ser-vf' })
      .expect(400);
    expect(bad.body.code).toBe('holded_series_not_excluded');
    const ready = await http()
      .put('/admin/platform-billing/holded')
      .set(auth)
      .send({ enabled: true, invoiceSeriesId: 'ser-ok' })
      .expect(200);
    expect(ready.body).toMatchObject({ ready: true, hasApiKey: true });
    expect(ready.body.pendingCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ready.body)).not.toContain('pat_platform');

    // «Enviar pendientes» copia la anterior: factura en su serie + cobro.
    const bf = await http().post('/admin/platform-billing/holded/backfill').set(auth).expect(200);
    expect(bf.body.synced).toBeGreaterThanOrEqual(1);
    const first = await admin.platformInvoice.findFirstOrThrow({ where: { tenantId: t.tenantId } });
    expect(first.holdedDocumentId).toBeTruthy();
    const created = holded.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.path === '/invoices' &&
        String(c.body?.description).includes(first.fullNumber),
    )!;
    expect(created.body).toMatchObject({ number_line_id: 'ser-ok' });
    expect(holded.calls).toContainEqual(
      expect.objectContaining({ path: `/invoices/${first.holdedDocumentId}/payments` }),
    );

    // Con Holded activo, un pago nuevo se copia al emitirse su factura.
    await http()
      .post(`/admin/tenants/${t.tenantId}/saas-payments/manual`)
      .set(auth)
      .send({ provider: 'cash', amount: 60.5, durationMonths: 1 })
      .expect(201);
    const all = await admin.platformInvoice.findMany({ where: { tenantId: t.tenantId } });
    expect(all).toHaveLength(2);
    expect(all.every((i) => i.holdedDocumentId)).toBe(true);
  }, 90_000);
});
