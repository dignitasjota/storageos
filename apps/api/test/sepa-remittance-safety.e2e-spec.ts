import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { buildN43 } from './helpers/n43';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const CREDITOR_IBAN = 'ES9121000418450200051332';
const DEBTOR_IBAN = 'ES7921000813610123456789';

/**
 * Remesas SEPA seguras: una factura en una remesa sin confirmar no se cobra
 * por otra vía; cancelar la remesa la libera; al confirmar se informan los
 * adeudos rechazados o que ya estaban pagados; una devolución permite
 * presentarla otra vez (y el mandato vuelve a FRST).
 */
describe('Remesas SEPA: estados de los adeudos (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let token: string;
  let customerId: string;
  let mandateId: string;

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function issued(unitPrice = 100): Promise<string> {
    const id = await createDraftInvoice(app, token, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  async function remittance(invoiceIds: string[]): Promise<string> {
    const r = await http()
      .post('/sepa/remittances')
      .set(auth())
      .send({ name: `Remesa ${Date.now()}`, collectionDate: '2026-12-30', invoiceIds })
      .expect(201);
    return r.body.id as string;
  }

  const items = async (remittanceId: string) =>
    (await http().get(`/sepa/remittances/${remittanceId}/prenotices`).set(auth()).expect(200))
      .body as { itemId: string; invoiceId: string; itemStatus: string; failureReason: string }[];

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    const owner = await registerVerifiedUser(app, 'sepasafe');
    await setTenantPlan(owner.slug, 'pro');
    token = owner.accessToken;
    await ensureDefaultSeries(app, token);
    await http()
      .put('/sepa/settings')
      .set(auth())
      .send({
        creditorName: 'Trasteros SL',
        creditorId: 'ES12ZZZB12345678',
        creditorIban: CREDITOR_IBAN,
        enabled: true,
      })
      .expect(200);
    customerId = await createCustomer(app, token, { email: `sepasafe-${Date.now()}@e2e.local` });
    const m = await http()
      .post('/sepa/mandates')
      .set(auth())
      .send({ customerId, iban: DEBTOR_IBAN, signedAt: '2026-01-15' })
      .expect(201);
    mandateId = m.body.id as string;
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('en una remesa sin confirmar no se cobra por otra vía; cancelarla la libera', async () => {
    const id = await issued();
    const rem = await remittance([id]);

    const cash = await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash', overridePaymentInFlight: true })
      .expect(409);
    expect(cash.body.code).toBe('invoice_in_sepa_remittance');
    const charge = await http().post(`/payments/invoices/${id}/charge`).set(auth()).send({});
    expect(charge.status).toBe(409);
    expect(charge.body.code).toBe('invoice_in_sepa_remittance');

    // Ni entra en otra remesa.
    const preview = await http().post('/sepa/remittances/preview').set(auth()).expect(200);
    expect(preview.body.eligible.some((e: { invoiceId: string }) => e.invoiceId === id)).toBe(
      false,
    );

    const cancelled = await http().post(`/sepa/remittances/${rem}/cancel`).set(auth()).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await items(rem))[0]!.itemStatus).toBe('cancelled');
    await http().post(`/sepa/remittances/${rem}/cancel`).set(auth()).expect(400);
    await http().post(`/sepa/remittances/${rem}/confirm`).set(auth()).expect(400);

    // Libre otra vez: ahora sí se cobra en efectivo.
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth())
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
  });

  it('confirmar informa de los adeudos rechazados y de los ya pagados por otra vía', async () => {
    const ok = await issued(100);
    const rejected = await issued(50);
    const paidElsewhere = await issued(30);
    const rem = await remittance([ok, rejected, paidElsewhere]);
    const its = await items(rem);
    const itemOf = (inv: string) => its.find((i) => i.invoiceId === inv)!.itemId;

    // Llega una transferencia por la tercera mientras la remesa está en el banco
    // (conciliación N43: dinero real, se registra aunque esté en la remesa).
    const imported = await http()
      .post('/bank-statements/import')
      .set(auth())
      .send({ filename: 'x.n43', content: buildN43('00000000003630', 'TRANSFER') })
      .expect(201);
    const statementId = imported.body.statements[0].id as string;
    const detail = await http().get(`/bank-statements/${statementId}`).set(auth()).expect(200);
    const credit = detail.body.transactions.find((t: { type: string }) => t.type === 'credit');
    await http()
      .post(`/bank-statements/transactions/${credit.id}/match`)
      .set(auth())
      .send({ invoiceId: paidElsewhere })
      .expect(200);

    const confirmed = await http()
      .post(`/sepa/remittances/${rem}/confirm`)
      .set(auth())
      .send({ rejectedItemIds: [itemOf(rejected)] })
      .expect(200);
    expect(confirmed.body).toMatchObject({ collectedCount: 1, failedCount: 2 });

    const after = await items(rem);
    expect(after.find((i) => i.invoiceId === ok)!.itemStatus).toBe('collected');
    expect(after.find((i) => i.invoiceId === rejected)).toMatchObject({
      itemStatus: 'failed',
      failureReason: 'Rechazado por el banco',
    });
    expect(after.find((i) => i.invoiceId === paidElsewhere)!.itemStatus).toBe('failed');

    const invRejected = await admin.invoice.findUniqueOrThrow({ where: { id: rejected } });
    expect(Number(invRejected.amountPaid)).toBe(0);
    // El rechazado puede ir en la siguiente remesa.
    const preview = await http().post('/sepa/remittances/preview').set(auth()).expect(200);
    expect(preview.body.eligible.some((e: { invoiceId: string }) => e.invoiceId === rejected)).toBe(
      true,
    );
    // Un único pago por la factura ya pagada (la transferencia), no dos.
    expect(await admin.payment.count({ where: { invoiceId: paidElsewhere } })).toBe(1);
    // El mandato ya cobró: RCUR.
    const mandate = await admin.sepaMandate.findUniqueOrThrow({ where: { id: mandateId } });
    expect(mandate.sequenceType).toBe('RCUR');
  });

  it('una devolución del banco permite volver a presentar la factura', async () => {
    // Mandato nuevo (FRST) para comprobar que vuelve a FRST tras la devolución.
    const customer2 = await createCustomer(app, token, {
      email: `sepasafe2-${Date.now()}@e2e.local`,
    });
    const m2 = await http()
      .post('/sepa/mandates')
      .set(auth())
      .send({ customerId: customer2, iban: DEBTOR_IBAN, signedAt: '2026-01-15' })
      .expect(201);
    const id = await createDraftInvoice(app, token, customer2, { unitPrice: 100 });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    const rem = await remittance([id]);
    await http().post(`/sepa/remittances/${rem}/confirm`).set(auth()).expect(200);
    expect(
      (await admin.sepaMandate.findUniqueOrThrow({ where: { id: m2.body.id } })).sequenceType,
    ).toBe('RCUR');

    // El banco devuelve 121 € (cargo en el extracto).
    const imported = await http()
      .post('/bank-statements/import')
      .set(auth())
      .send({
        filename: 'y.n43',
        content: buildN43('00000000000100', 'OTRO', '00000000012100'),
      })
      .expect(201);
    const statementId = imported.body.statements[0].id as string;
    const detail = await http().get(`/bank-statements/${statementId}`).set(auth()).expect(200);
    const debit = detail.body.transactions.find((t: { type: string }) => t.type === 'debit');
    await http()
      .post(`/bank-statements/transactions/${debit.id}/mark-return`)
      .set(auth())
      .send({ invoiceId: id })
      .expect(200);

    expect((await items(rem))[0]!.itemStatus).toBe('returned');
    expect(
      (await admin.sepaMandate.findUniqueOrThrow({ where: { id: m2.body.id } })).sequenceType,
    ).toBe('FRST');

    // Se puede presentar otra vez, como primer adeudo.
    const preview = await http().post('/sepa/remittances/preview').set(auth()).expect(200);
    const again = preview.body.eligible.find((e: { invoiceId: string }) => e.invoiceId === id);
    expect(again).toMatchObject({ amount: 121, sequenceType: 'FRST' });
    const rem2 = await remittance([id]);
    expect((await items(rem2))[0]!.itemStatus).toBe('pending');
  });
});
