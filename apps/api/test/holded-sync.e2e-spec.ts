import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { fakeHolded } from './helpers/fake-holded';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout esperando a Holded');
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Copia contable a Holded (API v2): series excluidas de Veri*Factu, número
 * legal en la descripción, cobros, rectificativas, simplificadas y anuladas.
 */
describe('Holded: copia contable de facturas (e2e)', () => {
  let app: INestApplication;
  let holded: Awaited<ReturnType<typeof fakeHolded>>;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    holded = await fakeHolded();
    process.env.HOLDED_API_BASE = holded.base;
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.HOLDED_API_BASE;
    holded.server.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  const holdedIdOf = (id: string) =>
    waitFor(
      async () => (await admin.invoice.findUnique({ where: { id } }))?.holdedDocumentId ?? null,
    );

  it('flujo completo', async () => {
    const owner = await registerVerifiedUser(app, 'holdedsync');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());

    // Activada sin serie: no está lista y no se envía nada.
    let s = await http()
      .put('/settings/holded')
      .set(auth)
      .send({ apiKey: 'pat_test_123456', enabled: true })
      .expect(200);
    expect(s.body).toMatchObject({ enabled: true, ready: false, invoiceSeriesId: null });

    const customerId = await createCustomer(app, owner.accessToken);
    const first = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${first}/issue`).set(auth).expect(200);
    await new Promise((r) => setTimeout(r, 600));
    expect(holded.calls.some((c) => c.path === '/invoices')).toBe(false);
    await http().post('/settings/holded/backfill').set(auth).expect(400);

    // Las series se leen de Holded; una que se envía a Verifactu no vale.
    const series = await http().get('/settings/holded/series').set(auth).expect(200);
    expect(series.body.invoice).toHaveLength(2);
    const bad = await http()
      .put('/settings/holded')
      .set(auth)
      .send({ enabled: true, invoiceSeriesId: 'ser-vf' })
      .expect(400);
    expect(bad.body.code).toBe('holded_series_not_excluded');
    s = await http()
      .put('/settings/holded')
      .set(auth)
      .send({ enabled: true, invoiceSeriesId: 'ser-ok', creditNoteSeriesId: 'ser-r' })
      .expect(200);
    expect(s.body.ready).toBe(true);

    // La factura emitida antes se envía con «Enviar pendientes».
    const bf = await http().post('/settings/holded/backfill').set(auth).expect(201);
    expect(bf.body.synced).toBe(1);
    const firstHolded = await holdedIdOf(first);
    const firstRow = await admin.invoice.findUniqueOrThrow({ where: { id: first } });
    const created = holded.calls.find((c) => c.method === 'POST' && c.path === '/invoices')!;
    expect(created.body).toMatchObject({ number_line_id: 'ser-ok' });
    expect(String(created.body!.description)).toContain(firstRow.invoiceNumber!);
    expect(created.body!.items).toEqual([
      { name: 'Cuota mes', units: 1, price: 100, taxes: ['s_iva_21'] },
    ]);
    expect(holded.calls.some((c) => c.path === `/invoices/${firstHolded}/approve`)).toBe(true);

    // Cobro → pago en Holded (una sola vez).
    await http()
      .post(`/invoices/${first}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    const pay = await waitFor(async () =>
      holded.calls.find((c) => c.path === `/invoices/${firstHolded}/payments`),
    );
    expect(pay.body).toMatchObject({ amount: '121.00' });
    await http().post('/settings/holded/backfill').set(auth).expect(201);
    expect(holded.calls.filter((c) => c.path === `/invoices/${firstHolded}/payments`)).toHaveLength(
      1,
    );

    // Rectificativa negativa → rectificativa en su serie, con líneas en positivo.
    const rect = await http()
      .post(`/invoices/${first}/rectify`)
      .set(auth)
      .send({
        rectificationType: 'R1',
        reason: 'Importe equivocado',
        items: [{ description: 'Ajuste', quantity: 1, unitPrice: -10, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${rect.body.id}/issue`).set(auth).expect(200);
    await holdedIdOf(rect.body.id as string);
    const cn = holded.calls.find((c) => c.method === 'POST' && c.path === '/credit-notes')!;
    expect(cn.body).toMatchObject({ number_line_id: 'ser-r' });
    expect(cn.body!.items).toEqual([{ name: 'Ajuste', units: 1, price: 10, taxes: ['s_iva_21'] }]);
    expect(String(cn.body!.description)).toContain(firstRow.invoiceNumber!);

    // Simplificada (sin cliente) → contacto genérico.
    await ensureDefaultSeries(app, owner.accessToken);
    const f2 = await http()
      .post('/invoices')
      .set(auth)
      .send({
        invoiceType: 'F2',
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${f2.body.id}/issue`).set(auth).expect(200);
    await holdedIdOf(f2.body.id as string);
    const generic = holded.calls.find(
      (c) =>
        c.method === 'POST' &&
        c.path === '/contacts' &&
        String(c.body?.name).startsWith('Clientes varios'),
    );
    expect(generic).toBeDefined();

    // Anulada → cancelada en Holded.
    const third = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${third}/issue`).set(auth).expect(200);
    const thirdHolded = await holdedIdOf(third);
    await http().post(`/invoices/${third}/cancel`).set(auth).send({ reason: 'Error' }).expect(200);
    await waitFor(async () =>
      holded.calls.find((c) => c.path === `/invoices/${thirdHolded}/cancel`),
    );
    const row = await admin.invoice.findUniqueOrThrow({ where: { id: third } });
    expect(row.holdedCancelledAt).not.toBeNull();
  }, 90_000);
});
