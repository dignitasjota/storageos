import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { fakeHolded } from './helpers/fake-holded';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Dónde se emiten las facturas del tenant: en la app (Veri*Factu) o en Holded
 * (Holded numera y registra). El cambio no se aplica en mitad del año.
 */
describe('Modo de emisión de facturas (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let holded: Awaited<ReturnType<typeof fakeHolded>>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    holded = await fakeHolded();
    process.env.HOLDED_API_BASE = holded.base;
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HOLDED_API_BASE;
    holded.server.close();
    await cleanupTestTenants();
  });

  const posts = (path: string) =>
    holded.calls.filter((c) => c.method === 'POST' && c.path === path);

  it('Holded emite: número de Holded, sin Veri*Factu propio, cobros y anulación', async () => {
    const owner = await registerVerifiedUser(app, 'invmodeh');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const start = await http().get('/settings/invoicing-mode').set(auth).expect(200);
    expect(start.body).toMatchObject({ mode: 'app', pendingMode: null, canChangeNow: true });

    // Sin Holded configurado no se puede elegir.
    const notReady = await http()
      .put('/settings/invoicing-mode')
      .set(auth)
      .send({ mode: 'holded' })
      .expect(400);
    expect(notReady.body.code).toBe('holded_issuing_not_ready');

    // Las series de emisión deben ir a Veri*Factu (al revés que las de copia).
    await http()
      .put('/settings/holded')
      .set(auth)
      .send({ apiKey: 'pat_issue_123456', enabled: false })
      .expect(200);
    const excluded = await http()
      .put('/settings/holded')
      .set(auth)
      .send({ enabled: false, issuingInvoiceSeriesId: 'ser-ok' })
      .expect(400);
    expect(excluded.body.code).toBe('holded_series_excluded');
    const cfg = await http()
      .put('/settings/holded')
      .set(auth)
      .send({
        enabled: false,
        issuingInvoiceSeriesId: 'ser-vf',
        issuingCreditNoteSeriesId: 'ser-rvf',
      })
      .expect(200);
    expect(cfg.body.issuingReady).toBe(true);

    // Aún no ha emitido nada este año: el cambio es inmediato.
    const now = await http()
      .put('/settings/invoicing-mode')
      .set(auth)
      .send({ mode: 'holded' })
      .expect(200);
    expect(now.body).toMatchObject({ mode: 'holded', pendingMode: null, holdedReady: true });

    // Emitir: dos a la vez → una sola factura en Holded.
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', delayMs: 300 });
    const [a, b] = await Promise.all([
      http().post(`/invoices/${id}/issue`).set(auth),
      http().post(`/invoices/${id}/issue`).set(auth),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    const created = posts('/invoices');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ number_line_id: 'ser-vf' });
    const docId = (await admin.invoice.findUniqueOrThrow({ where: { id } })).holdedDocumentId!;
    expect(ok.body).toMatchObject({
      status: 'issued',
      invoiceNumber: `H-${docId}`,
      issuedBy: 'holded',
      hash: null,
      aeatStatus: null,
    });
    expect(holded.calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: `/invoices/${docId}/approve` }),
    );

    // Su PDF es el de Holded.
    const pdf = await http().post(`/invoices/${id}/generate-pdf`).set(auth);
    expect(pdf.status).toBeLessThan(300);
    expect(holded.calls).toContainEqual(
      expect.objectContaining({ method: 'GET', path: `/invoices/${docId}/pdf` }),
    );
    // No se reenvía a la AEAT desde la app.
    const resend = await http().post(`/billing/invoices/${id}/resend-aeat`).set(auth);
    expect(resend.body.code).toBe('issued_by_holded');

    // El cobro va a esa factura de Holded.
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await waitFor(() => posts(`/invoices/${docId}/payments`).length === 1);

    // Anular otra factura emitida → la rectificativa la hace el tenant en
    // Holded (la API no permite enlazarla a la original): queda pendiente.
    const id2 = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${id2}/issue`).set(auth).expect(200);
    const cancel = await http()
      .post(`/invoices/${id2}/cancel`)
      .set(auth)
      .send({ reason: 'Error' })
      .expect(200);
    expect(cancel.body.status).toBe('rectified');
    expect(posts('/credit-notes')).toHaveLength(0);
    const pending = await admin.invoice.findFirstOrThrow({ where: { rectifiesInvoiceId: id2 } });
    expect(pending).toMatchObject({ status: 'draft', holdedSyncState: 'awaiting_holded' });
    const review = await http().get('/settings/holded/review').set(auth).expect(200);
    const item = (
      review.body as { kind: string; id: string; originalInvoiceNumber: string }[]
    ).find((r) => r.kind === 'credit_note_pending');
    expect(item).toMatchObject({
      id: pending.id,
      originalInvoiceNumber: cancel.body.invoiceNumber,
    });
    // Emitirla otra vez no la manda a Holded: sigue pendiente.
    await http().post(`/invoices/${pending.id}/issue`).set(auth).expect(200);
    expect(posts('/credit-notes')).toHaveLength(0);
    // El tenant la crea en Holded y la enlaza: queda emitida con el número de Holded.
    const linked = await http()
      .post(`/invoices/${pending.id}/link-holded`)
      .set(auth)
      .send({ holdedDocumentId: 'cn-manual' })
      .expect(200);
    expect(linked.body).toMatchObject({
      status: 'paid',
      issuedBy: 'holded',
      invoiceNumber: 'H-cn-manual',
      holdedDocumentId: 'cn-manual',
    });
    await http()
      .post(`/invoices/${pending.id}/link-holded`)
      .set(auth)
      .send({ holdedDocumentId: 'cn-manual' })
      .expect(409);

    // Holded no responde al crear → la factura queda reservada y no se duplica.
    const id3 = await createDraftInvoice(app, owner.accessToken, customerId);
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', drop: true });
    const fail = await http().post(`/invoices/${id3}/issue`).set(auth).expect(502);
    expect(fail.body.code).toBe('holded_issue_failed');
    const again = await http().post(`/invoices/${id3}/issue`).set(auth).expect(409);
    expect(again.body.code).toBe('invoice_issue_in_progress');
    expect(await admin.invoice.findUniqueOrThrow({ where: { id: id3 } })).toMatchObject({
      status: 'draft',
      holdedSyncState: 'creating',
    });
    // Holded rechaza (error HTTP) → se libera y se puede reintentar.
    await admin.invoice.update({
      where: { id: id3 },
      data: { holdedSyncState: null, holdedSyncStartedAt: null },
    });
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', status: 422 });
    await http().post(`/invoices/${id3}/issue`).set(auth).expect(502);
    expect(
      (await admin.invoice.findUniqueOrThrow({ where: { id: id3 } })).holdedSyncState,
    ).toBeNull();
    await http().post(`/invoices/${id3}/issue`).set(auth).expect(200);

    // Ya ha emitido este año: volver a la app queda para el 1 de enero.
    const later = await http()
      .put('/settings/invoicing-mode')
      .set(auth)
      .send({ mode: 'app' })
      .expect(200);
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(later.body).toMatchObject({
      mode: 'holded',
      pendingMode: 'app',
      pendingFrom: `${nextYear}-01-01`,
      canChangeNow: false,
    });
    // Elegir otra vez el modo actual anula el cambio programado.
    const undo = await http()
      .put('/settings/invoicing-mode')
      .set(auth)
      .send({ mode: 'holded' })
      .expect(200);
    expect(undo.body).toMatchObject({ mode: 'holded', pendingMode: null });

    // Llegada la fecha, el cambio programado se aplica solo.
    await http().put('/settings/invoicing-mode').set(auth).send({ mode: 'app' }).expect(200);
    await admin.tenant.update({
      where: { id: owner.tenantId },
      data: { invoicingModePendingFrom: new Date(Date.UTC(2000, 0, 1)) },
    });
    const applied = await http().get('/settings/invoicing-mode').set(auth).expect(200);
    expect(applied.body).toMatchObject({ mode: 'app', pendingMode: null });
    const id4 = await createDraftInvoice(app, owner.accessToken, customerId);
    const appIssued = await http().post(`/invoices/${id4}/issue`).set(auth).expect(200);
    expect(appIssued.body.issuedBy).toBe('app');
    // Con huella propia de Veri*Factu (pendiente o ya aceptada por el simulador).
    expect(appIssued.body.hash).toMatch(/^[0-9A-F]{64}$/);
  }, 60_000);
});
