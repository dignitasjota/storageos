import { ConfigService } from '@nestjs/config';
import request from 'supertest';

import {
  buildInvoiceDownloadToken,
  invoiceDownloadKey,
} from '../src/common/invoice-download-token';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import { FilesService } from '../src/modules/files/files.service';
import { JOB_DUNNING_EXECUTE_ACTION } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Mejoras de Facturas del panel del tenant, por el API real. */
describe('Facturas: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await cleanupTestTenants();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const authOf = (token: string) => ({ Authorization: `Bearer ${token}` });
  const madridToday = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

  async function tenant(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    await ensureDefaultSeries(app, owner.accessToken);
    const me = await http().get('/auth/me').set(authOf(owner.accessToken)).expect(200);
    return { ...owner, tenantId: me.body.tenant.id as string, auth: authOf(owner.accessToken) };
  }

  async function issued(token: string, customerId: string, price = 100): Promise<string> {
    const id = await createDraftInvoice(app, token, customerId, { unitPrice: price });
    await http().post(`/invoices/${id}/issue`).set(authOf(token)).send({}).expect(200);
    return id;
  }

  async function contractFor(
    owner: { auth: Record<string, string> },
    customerId: string,
    unitId: string,
  ): Promise<string> {
    const contract = await http().post('/contracts').set(owner.auth).send({
      customerId,
      unitId,
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    await http().post(`/contracts/${contract.body.id}/sign`).set(owner.auth).send({}).expect(200);
    return contract.body.id as string;
  }

  it('lista: tipo, orden por importe, totales y vistas del equipo', async () => {
    const owner = await tenant('invfeatlist');
    const customerId = await createCustomer(app, owner.accessToken);
    const big = await issued(owner.accessToken, customerId, 200);
    const small = await issued(owner.accessToken, customerId, 50);
    const f2 = await http()
      .post('/invoices')
      .set(owner.auth)
      .send({
        invoiceType: 'F2',
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${f2.body.id}/issue`).set(owner.auth).send({}).expect(200);
    await http()
      .post(`/invoices/${small}/mark-paid`)
      .set(owner.auth)
      .send({ amount: 60.5, methodType: 'cash' })
      .expect(200);

    const page = async (q: string) =>
      (await http().get(`/invoices/page?${q}`).set(owner.auth).expect(200)).body.items as {
        id: string;
        collection: { inFlight: boolean; lastReminderAt: string | null };
      }[];
    expect((await page('type=F2')).map((i) => i.id)).toEqual([f2.body.id]);
    expect((await page('type=F1&sort=amount')).map((i) => i.id)).toEqual([big, small]);
    // Cada fila trae el estado real del cobro.
    expect((await page('type=F1'))[0]!.collection).toMatchObject({
      inFlight: false,
      lastReminderAt: null,
    });
    const today = madridToday();
    expect(await page(`from=${today}&to=${today}`)).toHaveLength(3);
    const bad = await http().get('/invoices/page?sort=raro').set(owner.auth);
    expect(bad.body.code).toBe('invalid_sort');

    const totals = await http().get('/invoices/totals?type=F1').set(owner.auth).expect(200);
    expect(totals.body).toEqual({ count: 2, total: 302.5, pending: 242, collected: 60.5 });

    const view = await http()
      .post('/invoices/views')
      .set(owner.auth)
      .send({ name: 'Vencidas sin tarjeta', filters: { overdue: true, payment: 'none' } })
      .expect(201);
    // El mismo nombre la sustituye.
    await http()
      .post('/invoices/views')
      .set(owner.auth)
      .send({ name: 'Vencidas sin tarjeta', filters: { overdue: true } })
      .expect(201);
    const views = await http().get('/invoices/views').set(owner.auth).expect(200);
    expect(views.body).toHaveLength(1);
    expect(views.body[0].filters).toEqual({ overdue: true });
    await http().delete(`/invoices/views/${view.body.id}`).set(owner.auth).expect(204);
    expect((await http().get('/invoices/views').set(owner.auth)).body).toHaveLength(0);
  });

  it('corregir y deshacer un cobro registrado a mano; con la caja cerrada, no', async () => {
    const owner = await tenant('invfeatpay');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await issued(owner.accessToken, customerId);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(owner.auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    let activity = await http().get(`/invoices/${id}/activity`).set(owner.auth).expect(200);
    const paymentId = activity.body.payments[0].id as string;
    expect(activity.body.payments[0]).toMatchObject({ methodType: 'cash', editable: true });

    // Era una transferencia, no efectivo.
    await http()
      .patch(`/invoices/${id}/payments/${paymentId}`)
      .set(owner.auth)
      .send({ methodType: 'bank_transfer' })
      .expect(200);
    const future = await http()
      .patch(`/invoices/${id}/payments/${paymentId}`)
      .set(owner.auth)
      .send({ paidAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    expect(future.body.code).toBe('paid_at_in_future');

    // Se registró por error: se deshace y la factura vuelve a estar pendiente.
    const undone = await http()
      .post(`/invoices/${id}/payments/${paymentId}/undo`)
      .set(owner.auth)
      .send({ reason: 'Era de otra factura' })
      .expect(200);
    expect(undone.body.status).toBe('issued');
    expect(undone.body.amountPaid).toBe(0);
    activity = await http().get(`/invoices/${id}/activity`).set(owner.auth).expect(200);
    expect(activity.body.payments[0]).toMatchObject({ undone: true, editable: false });
    const actions = (activity.body.history as { action: string }[]).map((h) => h.action);
    expect(actions).toEqual(
      expect.arrayContaining(['invoice.payment_corrected', 'invoice.payment_undone']),
    );
    // Un cobro deshecho no cuenta como devolución.
    const returned = await admin.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(returned.returnedAt).toBeNull();

    // Efectivo de un día con la caja cerrada: no se toca.
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(owner.auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    activity = await http().get(`/invoices/${id}/activity`).set(owner.auth).expect(200);
    const cash = (activity.body.payments as { id: string; editable: boolean }[]).find(
      (p) => p.editable,
    )!;
    await http()
      .post('/cash/close')
      .set(owner.auth)
      .send({ date: madridToday(), countedCash: 121 })
      .expect(201);
    const locked = await http()
      .post(`/invoices/${id}/payments/${cash.id}/undo`)
      .set(owner.auth)
      .send({ reason: 'Error' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('cash_day_closed');
  });

  it('duplicar, y qué pasará al anular', async () => {
    const owner = await tenant('invfeatdup');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await issued(owner.accessToken, customerId, 80);

    const copy = await http().post(`/invoices/${id}/duplicate`).set(owner.auth).expect(201);
    expect(copy.body).toMatchObject({ status: 'draft', customerId, total: 96.8 });
    expect(copy.body.items[0]).toMatchObject({ unitPrice: 80, taxRate: 21 });

    const preview = await http().get(`/invoices/${id}/cancel-preview`).set(owner.auth).expect(200);
    expect(preview.body).toMatchObject({ action: 'void', creditNoteTotal: -96.8 });
    const draftPreview = await http()
      .get(`/invoices/${copy.body.id}/cancel-preview`)
      .set(owner.auth)
      .expect(200);
    expect(draftPreview.body.action).toBe('cancel_draft');

    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(owner.auth)
      .send({ amount: 96.8, methodType: 'cash' })
      .expect(200);
    const paid = await http().get(`/invoices/${id}/cancel-preview`).set(owner.auth).expect(200);
    expect(paid.body.action).toBe('blocked');
    expect(paid.body.blockedReason).toContain('cobros');

    // Una rectificativa no se duplica.
    const fee = await admin.invoice.update({
      where: { id: copy.body.id },
      data: { invoiceType: 'R4' },
    });
    const noDup = await http().post(`/invoices/${fee.id}/duplicate`).set(owner.auth);
    expect(noDup.body.code).toBe('cannot_duplicate');
  });

  it('devolución como saldo a favor: la descuenta su siguiente factura', async () => {
    const owner = await tenant('invfeatcredit');
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await contractFor(owner, customerId, unitIds[0]!);
    const invoice = async () => {
      const draft = await http()
        .post('/invoices')
        .set(owner.auth)
        .send({
          customerId,
          contractId,
          items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
        })
        .expect(201);
      await http().post(`/invoices/${draft.body.id}/issue`).set(owner.auth).send({}).expect(200);
      return draft.body.id as string;
    };
    const first = await invoice();
    await http()
      .post(`/invoices/${first}/mark-paid`)
      .set(owner.auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    const options = await http()
      .get(`/invoices/${first}/refund-options`)
      .set(owner.auth)
      .expect(200);
    expect(options.body).toMatchObject({
      refundable: 121,
      how: 'manual',
      methodType: 'cash',
      creditAvailable: true,
    });
    await http()
      .post(`/invoices/${first}/refund`)
      .set(owner.auth)
      .send({ amount: 30, reason: 'Le sobró', method: 'credit' })
      .expect(200);
    const refund = await admin.invoiceRefund.findFirstOrThrow({ where: { invoiceId: first } });
    expect(refund.via).toBe('credit');
    const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(Number(contract.creditBalance)).toBe(30);

    // La siguiente factura del contrato usa el saldo al emitirse.
    const second = await invoice();
    const next = await http().get(`/invoices/${second}`).set(owner.auth).expect(200);
    expect(next.body.amountPaid).toBe(30);
    expect(next.body.amountPending).toBe(91);
    const credit = await admin.payment.findFirstOrThrow({
      where: { invoiceId: second, methodType: 'credit_note' },
    });
    expect(Number(credit.amount)).toBe(30);
    const after = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(Number(after.creditBalance)).toBe(0);

    // Sin contrato no hay dónde dejar el saldo.
    const loose = await issued(owner.accessToken, customerId, 10);
    await http()
      .post(`/invoices/${loose}/mark-paid`)
      .set(owner.auth)
      .send({ amount: 12.1, methodType: 'cash' })
      .expect(200);
    const noContract = await http()
      .post(`/invoices/${loose}/refund`)
      .set(owner.auth)
      .send({ amount: 5, method: 'credit' });
    expect(noContract.body.code).toBe('credit_needs_contract');
  });

  it('enviar la factura por correo con su enlace de descarga', async () => {
    const owner = await tenant('invfeatsend');
    const email = `cliente-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const draft = await createDraftInvoice(app, owner.accessToken, customerId);
    const notYet = await http().post(`/invoices/${draft}/send`).set(owner.auth).send({});
    expect(notYet.body.code).toBe('invoice_not_sendable');

    await http().post(`/invoices/${draft}/issue`).set(owner.auth).send({}).expect(200);
    const detail = await http().get(`/invoices/${draft}`).set(owner.auth).expect(200);
    const number = detail.body.invoiceNumber as string;
    const sent = await http().post(`/invoices/${draft}/send`).set(owner.auth).send({}).expect(200);
    expect(sent.body.recipient).toBe(email);
    const mail = await waitForEmail(email, { subjectIncludes: `Factura ${number}` });
    expect(mail.Text).toContain(`/v1/public/invoices/${draft}.`);
    const activity = await http().get(`/invoices/${draft}/activity`).set(owner.auth).expect(200);
    expect(
      (activity.body.communications as { source: string }[]).some(
        (c) => c.source === 'invoice.sent',
      ),
    ).toBe(true);

    // El enlace público: firmado y solo de facturas emitidas.
    const key = invoiceDownloadKey(
      app.get(ConfigService).get<string>('MASTER_ENCRYPTION_KEY') ?? '',
    );
    const files = app.get(FilesService);
    await admin.invoice.update({
      where: { id: draft },
      data: { pdfUrl: files.buildPublicUrl('invoices', `${owner.tenantId}/${draft}.pdf`) },
    });
    const good = buildInvoiceDownloadToken(key, owner.tenantId, draft);
    const ok = await http().get(`/v1/public/invoices/${good}/pdf`).expect(302);
    expect(ok.headers.location).toContain(`${draft}.pdf`);
    const forged = `${draft}.${'A'.repeat(43)}`;
    await http().get(`/v1/public/invoices/${forged}/pdf`).expect(404);
    const otherDraft = await createDraftInvoice(app, owner.accessToken, customerId);
    const draftToken = buildInvoiceDownloadToken(key, owner.tenantId, otherDraft);
    await http().get(`/v1/public/invoices/${draftToken}/pdf`).expect(404);
  });

  it('cierre del mes y plazo de pago propio del inquilino', async () => {
    const owner = await tenant('invfeatmonth');
    const customerId = await createCustomer(app, owner.accessToken);
    await http()
      .patch(`/customers/${customerId}`)
      .set(owner.auth)
      .send({ invoiceDueDays: 45 })
      .expect(200);
    const id = await issued(owner.accessToken, customerId);
    const invoice = await http().get(`/invoices/${id}`).set(owner.auth).expect(200);
    const days =
      (Date.parse(`${invoice.body.dueDate}T00:00:00Z`) -
        Date.parse(`${invoice.body.issueDate}T00:00:00Z`)) /
      86_400_000;
    expect(days).toBe(45);

    const draft = await createDraftInvoice(app, owner.accessToken, customerId);
    const month = madridToday().slice(0, 7);
    const close = await http()
      .get(`/invoices/month-close?month=${month}`)
      .set(owner.auth)
      .expect(200);
    expect(close.body.month).toBe(month);
    const row = (close.body.drafts as { invoiceId: string; warnings: string[] }[]).find(
      (d) => d.invoiceId === draft,
    );
    expect(row?.warnings).toContain('no_payment_method');
    expect((close.body.pending as { invoiceId: string }[]).some((p) => p.invoiceId === id)).toBe(
      true,
    );
    const bad = await http().get('/invoices/month-close?month=2026-13').set(owner.auth);
    expect(bad.body.code).toBe('invalid_month');
    const future = await http()
      .post('/invoices/month-close/generate')
      .set(owner.auth)
      .send({ month: '2099-01' });
    expect(future.body.code).toBe('month_in_future');
  });

  it('un solo recordatorio para las facturas de un inquilino (a mano y en el escalado)', async () => {
    const owner = await tenant('invfeatsum');
    const email = `deudor-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const overdue = async (price: number) => {
      const id = await issued(owner.accessToken, customerId, price);
      await admin.invoice.update({
        where: { id },
        data: { status: 'overdue', dueDate: new Date(Date.now() - 5 * 86_400_000) },
      });
      return id;
    };
    const a = await overdue(100);
    const b = await overdue(50);

    const res = await http()
      .post('/invoices/bulk/remind')
      .set(owner.auth)
      .send({ ids: [a, b] })
      .expect(200);
    expect([...res.body.succeeded].sort()).toEqual([a, b].sort());
    const summaries = await admin.communication.findMany({
      where: { tenantId: owner.tenantId, source: 'bulk.reminder_summary' },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.subject).toBe('Tienes 2 facturas pendientes de pago');
    expect((summaries[0]!.variables as { invoiceIds: string[] }).invoiceIds.sort()).toEqual(
      [a, b].sort(),
    );
    // Las dos constan como recordadas.
    const page = await http().get(`/invoices/page?customerId=${customerId}`).set(owner.auth);
    for (const item of page.body.items as { collection: { lastReminderAt: string | null } }[]) {
      expect(item.collection.lastReminderAt).not.toBeNull();
    }
    // Y no se repite en el día.
    const again = await http()
      .post('/invoices/bulk/remind')
      .set(owner.auth)
      .send({ ids: [a, b] })
      .expect(200);
    expect(again.body.succeeded).toEqual([]);

    // El escalado: dos recordatorios del mismo día, un correo.
    const c = await overdue(30);
    const d = await overdue(20);
    const due = new Date(Date.now() - 60_000);
    const [actionC, actionD] = await Promise.all(
      [c, d].map((invoiceId) =>
        admin.dunningAction.create({
          data: {
            tenantId: owner.tenantId,
            invoiceId,
            actionType: 'email_reminder',
            status: 'scheduled',
            scheduledFor: due,
          },
        }),
      ),
    );
    await app
      .get(DunningService)
      .handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId: owner.tenantId, actionId: actionC!.id });
    const merged = await admin.communication.findMany({
      where: { tenantId: owner.tenantId, source: 'dunning.reminder_summary' },
    });
    expect(merged).toHaveLength(1);
    expect((merged[0]!.variables as { invoiceIds: string[] }).invoiceIds.sort()).toEqual(
      [c, d].sort(),
    );
    const sibling = await admin.dunningAction.findUniqueOrThrow({ where: { id: actionD!.id } });
    expect(sibling.status).toBe('executed');
    expect(sibling.result).toMatchObject({ mergedInto: actionC!.id });
    const single = await admin.communication.count({
      where: { tenantId: owner.tenantId, source: 'dunning.email_reminder' },
    });
    expect(single).toBe(0);
  });
});
