import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { PaymentsService } from '../src/modules/payments/payments.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const CREDITOR_IBAN = 'ES9121000418450200051332';
const DEBTOR_IBAN = 'ES7921000813610123456789';

/** Línea N43 de 80 caracteres a partir de tramos [posición 1-based, texto]. */
function n43Line(segments: [number, string][]): string {
  const buf = ' '.repeat(80).split('');
  for (const [pos, text] of segments) {
    for (let i = 0; i < text.length; i++) buf[pos - 1 + i] = text[i]!;
  }
  return buf.join('');
}

function n43WithCredit(amountCents: string, reference: string): string {
  return [
    n43Line([
      [1, '11'],
      [3, '2100'],
      [7, '0418'],
      [11, '0200051332'],
      [21, '260601'],
      [27, '260630'],
      [33, '2'],
      [34, '00000000100000'],
      [48, '978'],
    ]),
    n43Line([
      [1, '22'],
      [7, '260615'],
      [13, '260615'],
      [24, '2'],
      [25, amountCents],
      [61, reference],
    ]),
    n43Line([
      [1, '33'],
      [49, '2'],
      [50, '00000000112100'],
    ]),
    n43Line([[1, '88']]),
  ].join('\n');
}

/**
 * Operaciones de dinero lanzadas DOS VECES A LA VEZ (doble clic, dos personas,
 * dos webhooks): cada una debe surtir efecto una sola vez. Antes, varias leían
 * el estado fuera de la transacción y ambas pasaban el control.
 */
describe('Facturación: operaciones simultáneas (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function setup(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `${prefix}-${Date.now()}@e2e.local`,
    });
    return { owner, auth, customerId };
  }

  async function issuedInvoice(owner: { accessToken: string }, customerId: string) {
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);
    return id;
  }

  const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();

  it('emitir dos veces a la vez: un solo número, sin hueco en la serie', async () => {
    const { owner, auth, customerId } = await setup('cc-issue');
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    const before = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { seriesId: true },
    });
    const seriesBefore = await admin.invoiceSeries.findUniqueOrThrow({
      where: { id: before.seriesId },
      select: { nextNumber: true },
    });

    const rs = await Promise.all([
      request(app.getHttpServer()).post(`/invoices/${id}/issue`).set(auth),
      request(app.getHttpServer()).post(`/invoices/${id}/issue`).set(auth),
    ]);
    expect(statuses(rs)).toEqual([200, 409]);

    const seriesAfter = await admin.invoiceSeries.findUniqueOrThrow({
      where: { id: before.seriesId },
      select: { nextNumber: true },
    });
    // Solo se consume UN número.
    expect(seriesAfter.nextNumber).toBe(seriesBefore.nextNumber + 1);
    const inv = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { sequenceNumber: true },
    });
    expect(inv.sequenceNumber).toBe(seriesBefore.nextNumber);
  });

  it('cobrar a mano dos veces a la vez: un solo pago', async () => {
    const { owner, auth, customerId } = await setup('cc-paid');
    const id = await issuedInvoice(owner, customerId);
    const rs = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer())
          .post(`/invoices/${id}/mark-paid`)
          .set(auth)
          .send({ amount: 121, methodType: 'cash' }),
      ),
    );
    expect(statuses(rs)[0]).toBe(200);
    expect(statuses(rs)[1]).toBe(400);
    const payments = await admin.payment.count({ where: { invoiceId: id } });
    expect(payments).toBe(1);
    const inv = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { amountPaid: true, status: true },
    });
    expect(Number(inv.amountPaid)).toBe(121);
    expect(inv.status).toBe('paid');
  });

  it('dos cobros parciales a la vez se suman los dos (sin pisarse)', async () => {
    const { owner, auth, customerId } = await setup('cc-partial');
    const id = await issuedInvoice(owner, customerId);
    const rs = await Promise.all([
      request(app.getHttpServer())
        .post(`/invoices/${id}/mark-paid`)
        .set(auth)
        .send({ amount: 60, methodType: 'cash' }),
      request(app.getHttpServer())
        .post(`/invoices/${id}/mark-paid`)
        .set(auth)
        .send({ amount: 61, methodType: 'cash' }),
    ]);
    expect(statuses(rs)).toEqual([200, 200]);
    const inv = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { amountPaid: true, status: true },
    });
    expect(Number(inv.amountPaid)).toBe(121);
    expect(inv.status).toBe('paid');
  });

  it('reembolsar dos veces a la vez: un solo reembolso', async () => {
    const { owner, auth, customerId } = await setup('cc-refund');
    const id = await issuedInvoice(owner, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    const rs = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer())
          .post(`/invoices/${id}/refund`)
          .set(auth)
          .send({ amount: 121, reason: 'Doble clic' }),
      ),
    );
    expect(statuses(rs)[0]).toBe(200);
    expect(statuses(rs)[1]).toBe(400);
    const inv = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { amountRefunded: true, status: true },
    });
    expect(Number(inv.amountRefunded)).toBe(121);
    expect(inv.status).toBe('refunded');
  });

  it('conciliar dos veces a la vez el mismo apunte N43: un solo cobro', async () => {
    const { owner, auth, customerId } = await setup('cc-n43');
    await setTenantPlan(owner.slug, 'pro');
    const id = await issuedInvoice(owner, customerId);
    const number = (
      await admin.invoice.findUniqueOrThrow({ where: { id }, select: { invoiceNumber: true } })
    ).invoiceNumber;
    const imported = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'extracto.n43', content: n43WithCredit('00000000012100', number) })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/bank-statements/${imported.body.statements[0].id as string}`)
      .set(auth)
      .expect(200);
    const credit = detail.body.transactions.find((t: { type: string }) => t.type === 'credit');

    const rs = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer())
          .post(`/bank-statements/transactions/${credit.id as string}/match`)
          .set(auth)
          .send({ invoiceId: id }),
      ),
    );
    expect(statuses(rs)).toEqual([200, 400]);
    expect(await admin.payment.count({ where: { invoiceId: id } })).toBe(1);
  });

  it('confirmar dos veces a la vez la misma remesa SEPA: un solo cobro por factura', async () => {
    const { owner, auth, customerId } = await setup('cc-sepa');
    await setTenantPlan(owner.slug, 'pro');
    await request(app.getHttpServer())
      .put('/sepa/settings')
      .set(auth)
      .send({
        creditorName: 'Trasteros SL',
        creditorId: 'ES12ZZZB12345678',
        creditorIban: CREDITOR_IBAN,
        enabled: true,
      })
      .expect(200);
    await request(app.getHttpServer())
      .post('/sepa/mandates')
      .set(auth)
      .send({ customerId, iban: DEBTOR_IBAN, signedAt: '2026-01-15' })
      .expect(201);
    const id = await issuedInvoice(owner, customerId);
    const rem = await request(app.getHttpServer())
      .post('/sepa/remittances')
      .set(auth)
      .send({ name: 'Remesa', collectionDate: '2026-06-30', invoiceIds: [id] })
      .expect(201);

    const rs = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer())
          .post(`/sepa/remittances/${rem.body.id as string}/confirm`)
          .set(auth),
      ),
    );
    expect(statuses(rs)).toEqual([200, 400]);
    expect(await admin.payment.count({ where: { invoiceId: id } })).toBe(1);
    const inv = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { amountPaid: true },
    });
    expect(Number(inv.amountPaid)).toBe(121);
  });

  it('dos webhooks de cobro del mismo pago a la vez: se suma una sola vez', async () => {
    const { owner, customerId } = await setup('cc-webhook');
    const id = await issuedInvoice(owner, customerId);
    const inv = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { tenantId: true },
    });
    const gatewayPaymentId = `pi_cc_${Date.now()}`;
    await admin.payment.create({
      data: {
        tenantId: inv.tenantId,
        invoiceId: id,
        customerId,
        amount: 121,
        currency: 'EUR',
        status: 'processing',
        methodType: 'sepa_debit',
        gateway: 'stripe',
        gatewayPaymentId,
      },
    });

    const payments = app.get(PaymentsService);
    await Promise.all(
      [0, 1].map(() =>
        payments.syncFromWebhook({
          tenantId: inv.tenantId,
          gatewayPaymentId,
          newStatus: 'succeeded',
          paidAt: new Date(),
        }),
      ),
    );
    const after = await admin.invoice.findUniqueOrThrow({
      where: { id },
      select: { amountPaid: true, status: true },
    });
    expect(Number(after.amountPaid)).toBe(121);
    expect(after.status).toBe('paid');
  });
});
