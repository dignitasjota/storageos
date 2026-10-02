import request from 'supertest';

import { HoldedSyncService } from '../src/modules/accounting/holded-sync.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { fakeHolded } from './helpers/fake-holded';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Copia en Holded sin duplicados: envíos simultáneos, fallos al aprobar,
 * rechazos, errores de red (sin respuesta) y cobros devueltos tras copiarse.
 */
describe('Holded: copia idempotente (e2e)', () => {
  let app: INestApplication;
  let holded: Awaited<ReturnType<typeof fakeHolded>>;
  let admin: PrismaAdminService;
  let sync: HoldedSyncService;
  let tenantId: string;
  let token: string;
  let customerId: string;

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const creates = () =>
    holded.calls.filter((c) => c.method === 'POST' && c.path === '/invoices').length;

  /** Factura emitida sin que el aviso automático llegue a Holded (aún sin serie). */
  async function issuedInvoice(amount = 100): Promise<string> {
    const id = await createDraftInvoice(app, token, customerId, { unitPrice: amount });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  async function enable(): Promise<void> {
    await http()
      .put('/settings/holded')
      .set(auth())
      .send({ enabled: true, invoiceSeriesId: 'ser-ok', creditNoteSeriesId: 'ser-r' })
      .expect(200);
  }

  async function disable(): Promise<void> {
    await http().put('/settings/holded').set(auth()).send({ enabled: false }).expect(200);
  }

  beforeAll(async () => {
    holded = await fakeHolded();
    process.env.HOLDED_API_BASE = holded.base;
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    sync = app.get(HoldedSyncService);

    const owner = await registerVerifiedUser(app, 'holdedidem');
    token = owner.accessToken;
    const me = await http().get('/auth/me').set(auth()).expect(200);
    tenantId = me.body.tenant.id as string;
    await http()
      .put('/settings/holded')
      .set(auth())
      .send({ apiKey: 'pat_test_123456', enabled: true })
      .expect(200);
    await enable();
    await disable(); // los avisos automáticos no envían mientras se preparan los casos
    customerId = await createCustomer(app, token);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HOLDED_API_BASE;
    holded.server.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  beforeEach(() => {
    holded.faults.length = 0;
  });

  it('envíos simultáneos crean una sola factura y un solo cobro', async () => {
    const id = await issuedInvoice();
    await enable();
    holded.faults.push({
      match: (m, p) => m === 'POST' && p === '/invoices',
      delayMs: 400,
    });
    const before = creates();
    await Promise.all([
      sync.pushInvoice(tenantId, id, false),
      sync.pushInvoice(tenantId, id, false),
      sync.backfill(tenantId),
      sync.pushInvoice(tenantId, id, false),
    ]);
    expect(creates() - before).toBe(1);
    const row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedDocumentId).toBeTruthy();
    expect(row.holdedSyncState).toBeNull();

    // Cobro: el aviso de «pagada» y dos envíos manuales a la vez → un solo pago.
    await disable();
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await enable();
    holded.faults.push({
      match: (m, p) => m === 'POST' && p.endsWith('/payments'),
      delayMs: 300,
    });
    await Promise.all([
      sync.pushInvoice(tenantId, id, false),
      sync.backfill(tenantId),
      sync.pushInvoice(tenantId, id, false),
    ]);
    const payments = holded.calls.filter(
      (c) => c.path === `/invoices/${row.holdedDocumentId}/payments`,
    );
    expect(payments).toHaveLength(1);
    await disable();
  });

  it('si falla la aprobación, el reintento solo aprueba (no crea otra)', async () => {
    const id = await issuedInvoice();
    await enable();
    holded.faults.push({ match: (_m, p) => p.endsWith('/approve'), status: 500 });
    const before = creates();
    await expect(sync.pushInvoice(tenantId, id, true)).rejects.toBeDefined();
    let row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedDocumentId).toBeTruthy();
    expect(row.holdedSyncState).toBe('approving');

    await sync.backfill(tenantId);
    row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedSyncState).toBeNull();
    expect(creates() - before).toBe(1);
    expect(
      holded.calls.filter((c) => c.path === `/invoices/${row.holdedDocumentId}/approve`),
    ).toHaveLength(2);
    await disable();
  });

  it('si Holded la rechaza, se libera y se reintenta', async () => {
    const id = await issuedInvoice();
    await enable();
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', status: 422 });
    await expect(sync.pushInvoice(tenantId, id, true)).rejects.toBeDefined();
    let row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedSyncState).toBeNull();
    expect(row.holdedDocumentId).toBeNull();

    await sync.pushInvoice(tenantId, id, true);
    row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedDocumentId).toBeTruthy();
    await disable();
  });

  it('sin respuesta de Holded no se reintenta sola: queda para revisar', async () => {
    const id = await issuedInvoice();
    await enable();
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', drop: true });
    await expect(sync.pushInvoice(tenantId, id, true)).rejects.toBeDefined();
    let row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedSyncState).toBe('creating');

    // «Enviar pendientes» no la vuelve a crear.
    const before = creates();
    await sync.backfill(tenantId);
    expect(creates()).toBe(before);

    // Pasados unos minutos, sale para revisar.
    await admin.invoice.update({
      where: { id },
      data: { holdedSyncStartedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const settings = await http().get('/settings/holded').set(auth()).expect(200);
    expect(settings.body.reviewCount).toBeGreaterThanOrEqual(1);
    const review = await http().get('/settings/holded/review').set(auth()).expect(200);
    expect(review.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'invoice_unconfirmed', id })]),
    );

    // Enlazar sin id → 400; «no está en Holded» → se vuelve a enviar.
    await http()
      .post(`/settings/holded/review/invoices/${id}`)
      .set(auth())
      .send({ action: 'already_in_holded' })
      .expect(400);
    await http()
      .post(`/settings/holded/review/invoices/${id}`)
      .set(auth())
      .send({ action: 'retry' })
      .expect(200);
    await sync.backfill(tenantId);
    row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedDocumentId).toBeTruthy();
    expect(creates()).toBe(before + 1);

    // Ya no hay nada que resolver con ese id.
    await http()
      .post(`/settings/holded/review/invoices/${id}`)
      .set(auth())
      .send({ action: 'retry' })
      .expect(404);
    await disable();
  });

  it('enlazar a mano una factura que sí estaba en Holded', async () => {
    const id = await issuedInvoice();
    await enable();
    holded.faults.push({ match: (m, p) => m === 'POST' && p === '/invoices', drop: true });
    await expect(sync.pushInvoice(tenantId, id, true)).rejects.toBeDefined();
    await http()
      .post(`/settings/holded/review/invoices/${id}`)
      .set(auth())
      .send({ action: 'already_in_holded', holdedDocumentId: 'inv-manual' })
      .expect(200);
    const row = await admin.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.holdedDocumentId).toBe('inv-manual');
    expect(row.holdedSyncState).toBeNull();
    await disable();
  });

  it('un cobro copiado y luego reembolsado sale para revisar', async () => {
    const id = await issuedInvoice();
    await enable();
    await sync.pushInvoice(tenantId, id, true);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await sync.pushInvoice(tenantId, id, true);
    const payment = await admin.payment.findFirstOrThrow({ where: { invoiceId: id } });
    expect(payment.holdedSyncedAt).not.toBeNull();

    await http()
      .post(`/invoices/${id}/refund`)
      .set(auth())
      .send({ amount: 121, reason: 'Devolución' })
      .expect(200);
    const review = await http().get('/settings/holded/review').set(auth()).expect(200);
    expect(review.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'payment_reversed', id: payment.id }),
      ]),
    );
    await http()
      .post(`/settings/holded/review/payments/${payment.id}`)
      .set(auth())
      .send({ action: 'reviewed' })
      .expect(200);
    const after = await http().get('/settings/holded/review').set(auth()).expect(200);
    expect((after.body as Array<{ id: string }>).some((i) => i.id === payment.id)).toBe(false);
    await disable();
  });
});
