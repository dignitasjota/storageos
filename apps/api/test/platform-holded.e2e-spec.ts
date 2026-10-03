import request from 'supertest';

import { PlatformHoldedService } from '../src/modules/billing-saas/platform-holded.service';
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
      data: {
        holdedEnabled: false,
        holdedApiKeyEncrypted: null,
        holdedInvoiceSeriesId: null,
        holdedCreditNoteSeriesId: null,
      },
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

  it('sin duplicados (envíos a la vez, sin respuesta) y rectificativas', async () => {
    const http = () => request(app.getHttpServer());
    const svc = app.get(PlatformHoldedService);
    const postsFor = (path: string, number: string) =>
      holded.calls.filter(
        (c) =>
          c.method === 'POST' && c.path === path && String(c.body?.description).includes(number),
      );

    await http()
      .put('/admin/platform-billing/holded')
      .set(auth)
      .send({ enabled: true, invoiceSeriesId: 'ser-ok', creditNoteSeriesId: 'ser-r' })
      .expect(200);

    const t = await registerVerifiedUser(app, 'platholdedb');
    await admin.tenant.update({
      where: { id: t.tenantId },
      data: {
        taxId: '12345678Z',
        billingLegalName: 'Trasteros B SL',
        billingAddress: 'Calle Uno 1',
        billingCity: 'Madrid',
        billingPostalCode: '28001',
      },
    });
    // Facturas emitidas con la copia apagada (quedan pendientes).
    await admin.platformBillingSettings.updateMany({ data: { holdedEnabled: false } });
    for (const amount of [121, 60.5, 30.25]) {
      await http()
        .post(`/admin/tenants/${t.tenantId}/saas-payments/manual`)
        .set(auth)
        .send({ provider: 'bank_transfer', amount, durationMonths: 1 })
        .expect(201);
    }
    await admin.platformBillingSettings.updateMany({ data: { holdedEnabled: true } });
    const [a, b, c] = await admin.platformInvoice.findMany({
      where: { tenantId: t.tenantId },
      orderBy: { issuedAt: 'asc' },
    });

    // Dos envíos a la vez de la misma factura → una sola copia y un solo cobro.
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', delayMs: 300 });
    await Promise.all([svc.pushBestEffort(a!.id), svc.pushBestEffort(a!.id)]);
    expect(postsFor('/invoices', a!.fullNumber)).toHaveLength(1);
    await svc.pushBestEffort(a!.id);
    const aDoc = (await admin.platformInvoice.findUniqueOrThrow({ where: { id: a!.id } }))
      .holdedDocumentId!;
    expect(
      holded.calls.filter((x) => x.method === 'POST' && x.path === `/invoices/${aDoc}/payments`),
    ).toHaveLength(1);

    // Holded no responde → la reserva se queda y sale para revisar.
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', drop: true });
    await svc.pushBestEffort(b!.id);
    await svc.pushBestEffort(b!.id); // no reintenta solo
    expect(postsFor('/invoices', b!.fullNumber)).toHaveLength(1);
    await admin.platformInvoice.update({
      where: { id: b!.id },
      data: { holdedSyncStartedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const review = await http().get('/admin/platform-billing/holded/review').set(auth).expect(200);
    expect(review.body).toContainEqual(
      expect.objectContaining({ invoiceId: b!.id, kind: 'invoice' }),
    );
    // Se comprobó en Holded que sí se creó: se enlaza y se aprueba sin duplicar.
    await http()
      .post(`/admin/platform-billing/holded/review/${b!.id}`)
      .set(auth)
      .send({ kind: 'invoice', action: 'already_in_holded', holdedDocumentId: 'inv-manual' })
      .expect(204);
    await http().post('/admin/platform-billing/holded/backfill').set(auth).expect(200);
    const bAfter = await admin.platformInvoice.findUniqueOrThrow({ where: { id: b!.id } });
    expect(bAfter).toMatchObject({ holdedDocumentId: 'inv-manual', holdedSyncState: null });
    expect(holded.calls).toContainEqual(
      expect.objectContaining({ path: '/invoices/inv-manual/approve' }),
    );
    expect(holded.calls).toContainEqual(
      expect.objectContaining({ path: '/invoices/inv-manual/payments' }),
    );
    expect(postsFor('/invoices', b!.fullNumber)).toHaveLength(1);

    // Abono parcial de A → rectificativa de Holded en la serie de rectificativas.
    const credit = await http()
      .post(`/admin/platform-invoices/${a!.id}/rectify`)
      .set(auth)
      .send({ method: 'differences', reason: 'Descuento', amount: 60.5 })
      .expect(201);
    const cn = postsFor('/credit-notes', credit.body.fullNumber);
    expect(cn).toHaveLength(1);
    expect(cn[0]!.body).toMatchObject({ number_line_id: 'ser-r' });
    const cnItems = cn[0]!.body!.items as { price: number }[];
    expect(cnItems[0]!.price).toBe(50); // en positivo: Holded ya resta

    // Sustitución de C (ya copiada) → anulación de la original + factura nueva, sin cobro.
    await svc.pushBestEffort(c!.id);
    const subst = await http()
      .post(`/admin/platform-invoices/${c!.id}/rectify`)
      .set(auth)
      .send({ method: 'substitution', reason: 'Datos fiscales' })
      .expect(201);
    expect(postsFor('/credit-notes', c!.fullNumber)).toHaveLength(1); // anula la original
    const newInv = postsFor('/invoices', subst.body.fullNumber);
    expect(newInv).toHaveLength(1);
    expect(newInv[0]!.body).toMatchObject({ number_line_id: 'ser-ok' });
    const substRow = await admin.platformInvoice.findUniqueOrThrow({
      where: { id: subst.body.id },
    });
    expect(substRow.holdedCreditNoteId).toBeTruthy();
    expect(substRow.holdedDocumentId).toBeTruthy();
    expect(
      holded.calls.some((x) => x.path === `/invoices/${substRow.holdedDocumentId}/payments`),
    ).toBe(false);

    // Ya no queda nada pendiente de este tenant.
    await http().post('/admin/platform-billing/holded/backfill').set(auth).expect(200);
    expect(postsFor('/invoices', subst.body.fullNumber)).toHaveLength(1);
    expect(postsFor('/credit-notes', c!.fullNumber)).toHaveLength(1);
  }, 90_000);
});
