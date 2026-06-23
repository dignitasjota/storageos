import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Construye una línea N43 de 80 chars desde tramos [pos1, texto]. */
function n43Line(segments: [number, string][]): string {
  const buf = ' '.repeat(80).split('');
  for (const [pos, text] of segments) {
    for (let i = 0; i < text.length; i++) buf[pos - 1 + i] = text[i]!;
  }
  return buf.join('');
}

function buildN43(creditAmount: string, reference: string, debitAmount = '00000000005000'): string {
  const header = n43Line([
    [1, '11'],
    [3, '2100'],
    [7, '0418'],
    [11, '0200051332'],
    [21, '260601'],
    [27, '260630'],
    [33, '2'],
    [34, '00000000100000'],
    [48, '978'],
  ]);
  const credit = n43Line([
    [1, '22'],
    [7, '260615'],
    [13, '260615'],
    [24, '2'],
    [25, creditAmount],
    [61, reference],
  ]);
  const debit = n43Line([
    [1, '22'],
    [7, '260616'],
    [13, '260616'],
    [24, '1'],
    [25, debitAmount],
  ]);
  const footer = n43Line([
    [1, '33'],
    [49, '2'],
    [50, '00000000107100'],
  ]);
  const eof = n43Line([[1, '88']]);
  return [header, credit, debit, footer, eof].join('\n');
}

describe('Conciliación N43 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('importa N43 → sugiere factura por importe+referencia → concilia → factura pagada', async () => {
    const owner = await registerVerifiedUser(app, 'n43');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(auth)
      .expect(200);
    const invoiceNumber = issued.body.invoiceNumber as string;

    // Fichero N43 con un abono de 121.00 € y la referencia = nº de factura.
    const content = buildN43('00000000012100', invoiceNumber);
    const imported = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'extracto.n43', content });
    expect(imported.status).toBe(201);
    expect(imported.body.statements).toHaveLength(1);
    expect(imported.body.suggestedCount).toBe(1);
    const statementId = imported.body.statements[0].id as string;

    // Detalle: 2 movimientos (abono + cargo); el abono trae sugerencia.
    const detail = await request(app.getHttpServer())
      .get(`/bank-statements/${statementId}`)
      .set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.transactions).toHaveLength(2);
    const credit = detail.body.transactions.find((t: { type: string }) => t.type === 'credit');
    const debit = detail.body.transactions.find((t: { type: string }) => t.type === 'debit');
    expect(credit.amount).toBe(121);
    expect(debit.amount).toBe(-50);
    expect(credit.suggestions).toHaveLength(1);
    expect(credit.suggestions[0].invoiceId).toBe(invoiceId);
    expect(credit.suggestions[0].amountPending).toBe(121);

    // Conciliar el abono con la factura → factura pagada.
    const matched = await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(auth)
      .send({ invoiceId });
    expect(matched.status).toBe(200);
    const matchedCredit = matched.body.transactions.find((t: { id: string }) => t.id === credit.id);
    expect(matchedCredit.status).toBe('matched');
    expect(matchedCredit.matchedInvoiceNumber).toBe(invoiceNumber);

    const invoice = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(invoice.body.status).toBe('paid');

    // Reconciliar de nuevo → 400.
    const again = await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(auth)
      .send({ invoiceId });
    expect(again.status).toBe(400);
  });

  it('devolución SEPA: un cargo del mismo importe revierte la factura cobrada', async () => {
    const owner = await registerVerifiedUser(app, 'n43ret');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(auth)
      .expect(200);
    const invoiceNumber = issued.body.invoiceNumber as string;

    // Conciliar el abono → factura pagada.
    const file1 = buildN43('00000000012100', invoiceNumber);
    const imp1 = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'cobro.n43', content: file1 });
    const detail1 = await request(app.getHttpServer())
      .get(`/bank-statements/${imp1.body.statements[0].id}`)
      .set(auth);
    const credit = detail1.body.transactions.find((t: { type: string }) => t.type === 'credit');
    await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(auth)
      .send({ invoiceId })
      .expect(200);
    expect(
      (await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth)).body.status,
    ).toBe('paid');

    // Segundo extracto con un CARGO de 121 € (la devolución) + ref de la factura.
    const file2 = buildN43('00000000000100', `OTRA-${invoiceNumber}`, '00000000012100');
    const imp2 = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'devolucion.n43', content: file2 });
    const stId = imp2.body.statements[0].id as string;
    const detail2 = await request(app.getHttpServer()).get(`/bank-statements/${stId}`).set(auth);
    const debit = detail2.body.transactions.find((t: { type: string }) => t.type === 'debit');
    expect(debit.amount).toBe(-121);
    // El cargo sugiere la factura pagada como devolución.
    expect(debit.returnSuggestions.length).toBeGreaterThanOrEqual(1);
    expect(debit.returnSuggestions[0].invoiceId).toBe(invoiceId);

    // Marcar devolución → factura vuelve a vencida/emitida.
    const ret = await request(app.getHttpServer())
      .post(`/bank-statements/transactions/${debit.id}/mark-return`)
      .set(auth)
      .send({ invoiceId });
    expect(ret.status).toBe(200);
    const retDebit = ret.body.transactions.find((t: { id: string }) => t.id === debit.id);
    expect(retDebit.status).toBe('returned');

    const after = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(['overdue', 'issued']).toContain(after.body.status);
    expect(after.body.amountPaid).toBe(0);
  });

  it('rechaza un fichero sin movimientos válidos', async () => {
    const owner = await registerVerifiedUser(app, 'n43b');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const res = await request(app.getHttpServer())
      .post('/bank-statements/import')
      .set(auth)
      .send({ filename: 'vacio.txt', content: 'no es un n43\nninguna linea valida' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_n43');
  });
});
