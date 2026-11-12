import request from 'supertest';

import { DataRetentionService } from '../src/modules/data-retention/data-retention.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { SignaturesService } from '../src/modules/move-in/signatures.service';
import {
  encodeMerchantParameters,
  signRequest,
} from '../src/modules/payments/redsys/redsys-signature';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

/**
 * Reserva online: el contrato entra en vigor con el primer pago, así que su
 * factura se prepara al firmar como borrador (sin número ni registro
 * Veri*Factu) y se emite al cobrarse. Si la reserva caduca sin pagar, el
 * borrador se anula sin gastar número ni hacer una rectificativa.
 */
describe('Primera factura de la reserva online al cobrar (e2e)', () => {
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

  const http = () => request(app.getHttpServer());

  async function book(suffix: string, opts: { deposit?: number } = {}) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    if (opts.deposit) {
      await http()
        .patch(`/unit-types/${unitTypeId}`)
        .set(auth)
        .send({ defaultDepositAmount: opts.deposit })
        .expect(200);
    }
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    const facility = avail.body.facilities[0];
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: new Date().toISOString().slice(0, 10),
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Lucía',
          lastName: 'Pardo',
          email: `fip-${suffix}-${Date.now()}@e2e.local`,
        },
      })
      .expect(201);
    return {
      owner,
      auth,
      token: booking.body.signingToken as string,
      contractId: booking.body.contractId as string,
    };
  }

  async function sign(token: string) {
    const res = await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Lucía Pardo',
        method: 'typed',
        typedSignature: 'Lucía Pardo',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      })
      .expect(201);
    return res.body.portalToken as string;
  }

  const firstInvoice = (contractId: string) =>
    admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
      orderBy: { createdAt: 'asc' },
    });

  it('el contrato dice que entra en vigor con el primer pago', async () => {
    const { token } = await book('fipterms');
    const view = await http().get(`/public/move-in/sign/${token}`).expect(200);
    expect(view.body.termsText).toContain('Entrada en vigor: con el primer pago');
    expect(view.body.termsText).toContain('72 horas');
  });

  it('al firmar queda pendiente de pago sin número; al cobrar con Redsys se emite', async () => {
    const { auth, token, contractId } = await book('fipredsys', { deposit: 40 });
    const portalToken = await sign(token);

    const draft = await firstInvoice(contractId);
    expect(draft.status).toBe('draft');
    expect(draft.issueOnPayment).toBe(true);
    expect(draft.invoiceNumber).toMatch(/^DRAFT-/);
    expect(draft.hash).toBeNull();
    expect(draft.issueDate).toBeNull();
    const receipt = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'deposit_receipt' },
    });
    expect(receipt.bundledWithInvoiceId).toBe(draft.id);

    // El inquilino lo ve en su área de clientes como pendiente de pago.
    const mine = await http()
      .get('/portal/me/invoices')
      .set('Authorization', `Bearer ${portalToken}`)
      .expect(200);
    const row = (mine.body as { id: string; status: string; amountPending: number }[]).find(
      (i) => i.id === draft.id,
    );
    expect(row).toMatchObject({ status: 'draft' });
    expect(row!.amountPending).toBeGreaterThan(0);

    // En el panel, también pendiente y fuera del libro de IVA.
    const dto = await http().get(`/invoices/${draft.id}`).set(auth).expect(200);
    expect(dto.body).toMatchObject({ status: 'draft', issueOnPayment: true });
    expect(dto.body.amountPending).toBeGreaterThan(0);
    const year = new Date().getFullYear();
    const before = await http()
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(auth)
      .expect(200);
    expect(before.body.rows).toHaveLength(0);

    // Pago con tarjeta por Redsys (factura + fianza en un solo cobro).
    await http()
      .put('/settings/redsys')
      .set(auth)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: TEST_KEY,
        environment: 'test',
        enabled: true,
      })
      .expect(200);
    const redirect = await http()
      .post(`/portal/me/invoices/${draft.id}/redsys-redirect`)
      .set('Authorization', `Bearer ${portalToken}`)
      .send({})
      .expect(200);
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    );
    expect(params.DS_MERCHANT_PRODUCTDESCRIPTION).toBe('Primer pago de la reserva');
    const cents = Math.round((Number(draft.total) + 40) * 100);
    expect(params.DS_MERCHANT_AMOUNT).toBe(String(cents));
    const order = params.DS_MERCHANT_ORDER as string;
    const notif = encodeMerchantParameters({
      Ds_Order: order,
      Ds_Response: '0000',
      Ds_Amount: String(cents),
    });
    await http()
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: notif,
        Ds_Signature: signRequest(notif, order, TEST_KEY),
      })
      .expect(200);

    const paid = await admin.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(paid.status).toBe('paid');
    expect(paid.invoiceNumber).not.toMatch(/^DRAFT-/);
    expect(paid.issueDate).not.toBeNull();
    expect(Number(paid.amountPaid)).toBe(Number(paid.total));
    const rec = await admin.invoice.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(rec.status).toBe('paid');

    const after = await http()
      .get(`/fiscal/vat-book?from=${year}-01-01&to=${year}-12-31`)
      .set(auth)
      .expect(200);
    expect((after.body.rows as { invoiceNumber: string }[]).map((r) => r.invoiceNumber)).toEqual([
      paid.invoiceNumber,
    ]);
  });

  it('registrar el cobro en el panel la emite y la deja pagada', async () => {
    const { auth, token, contractId } = await book('fipmanual');
    await sign(token);
    const draft = await firstInvoice(contractId);
    expect(draft.status).toBe('draft');

    const res = await http()
      .post(`/invoices/${draft.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(draft.total), methodType: 'bank_transfer' })
      .expect(200);
    expect(res.body.status).toBe('paid');
    expect(res.body.invoiceNumber).not.toMatch(/^DRAFT-/);
    expect(res.body.issueOnPayment).toBe(true);
  });

  it('si la reserva caduca sin pagar, el borrador se anula sin factura ni rectificativa', async () => {
    const { auth, token, contractId } = await book('fipexpire');
    await sign(token);
    const draft = await firstInvoice(contractId);
    await admin.contract.update({
      where: { id: contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - 60_000) },
    });
    await app.get(SignaturesService).expireUnpaidBookings();

    const cancelled = await admin.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.invoiceNumber).toMatch(/^DRAFT-/);
    expect(await admin.invoice.count({ where: { rectifiesInvoiceId: draft.id } })).toBe(0);
    const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.status).toBe('cancelled');

    // Fuera de la exportación para la asesoría (nunca fue una factura).
    const today = new Date().toISOString().slice(0, 10);
    const exp = await http()
      .get(`/fiscal/accountant-export?from=${today}&to=${today}`)
      .set(auth)
      .expect(200);
    expect(exp.body.invoices).toHaveLength(0);
  });

  it('a los 30 días anonimiza a quien reservó y no llegó a firmar', async () => {
    const { contractId } = await book('fipabandon');
    // La reserva caduca sin firmar.
    await admin.contract.update({
      where: { id: contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - 60_000) },
    });
    await app.get(SignaturesService).expireUnpaidBookings();
    const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.status).toBe('cancelled');
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await admin.$executeRaw`UPDATE customers SET created_at = ${old} WHERE id = ${contract.customerId}::uuid`;
    await admin.$executeRaw`UPDATE contracts SET updated_at = ${old} WHERE id = ${contractId}::uuid`;

    const done = await app.get(DataRetentionService).anonymizeAbandonedBookings();
    expect(done).toBeGreaterThanOrEqual(1);
    const customer = await admin.customer.findUniqueOrThrow({
      where: { id: contract.customerId },
    });
    expect(customer.firstName).toBe('*** ANONIMIZADO ***');
    expect(customer.email).toBeNull();
    expect(customer.documentNumber).toBeNull();
    expect(customer.deletedAt).not.toBeNull();
    const gone = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(gone.deletedAt).not.toBeNull();
  });
});
