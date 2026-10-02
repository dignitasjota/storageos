import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import {
  encodeMerchantParameters,
  signRequest,
} from '../src/modules/payments/redsys/redsys-signature';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

/**
 * Reserva online con fianza: la fianza va en un justificante aparte (no en la
 * factura), se cobra en el mismo pago que la 1ª factura y queda fuera de los
 * informes fiscales; el acceso se emite al cobrarse los dos.
 */
describe('Reserva online con fianza (e2e)', () => {
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

  async function bookAndSign(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    await request(app.getHttpServer())
      .patch(`/unit-types/${unitTypeId}`)
      .set(auth)
      .send({ defaultDepositAmount: 60 })
      .expect(200);
    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: { firstName: 'Bea', lastName: 'López', email: `dep-${Date.now()}@e2e.local` },
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({ signerName: 'Bea López', method: 'typed', typedSignature: 'Bea López', accept: true })
      .expect(201);
    const contractId = booking.body.contractId as string;
    const docs = await admin.invoice.findMany({
      where: { contractId },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
    });
    const invoice = docs.find((d) => d.kind === 'invoice')!;
    const receipt = docs.find((d) => d.kind === 'deposit_receipt')!;
    return { owner, auth, contractId, invoice, receipt };
  }

  it('la fianza va en un justificante aparte, fuera de la factura y de los informes', async () => {
    const { auth, invoice, receipt, contractId } = await bookAndSign('bookdep');

    // La factura ya no lleva la fianza.
    expect(invoice.items.some((i) => i.description.toLowerCase().includes('fianza'))).toBe(false);
    expect(invoice.items.every((i) => Number(i.taxRate) === 21)).toBe(true);

    // Justificante: sin IVA, sin huella, enlazado a la factura.
    expect(receipt.invoiceNumber).toMatch(/^FZ-/);
    expect(Number(receipt.total)).toBe(60);
    expect(Number(receipt.taxAmount)).toBe(0);
    expect(receipt.hash).toBeNull();
    expect(receipt.aeatStatus).toBeNull();
    expect(receipt.status).toBe('issued');
    expect(receipt.bundledWithInvoiceId).toBe(invoice.id);

    const dto = await request(app.getHttpServer()).get(`/invoices/${receipt.id}`).set(auth);
    expect(dto.body).toMatchObject({ kind: 'deposit_receipt', bundledWithInvoiceId: invoice.id });

    // Fuera del libro de IVA.
    const book = await request(app.getHttpServer())
      .get('/fiscal/vat-book?from=2026-01-01&to=2027-12-31')
      .set(auth)
      .expect(200);
    const numbers = (book.body.rows as { invoiceNumber: string }[]).map((r) => r.invoiceNumber);
    expect(numbers).toContain(invoice.invoiceNumber);
    expect(numbers).not.toContain(receipt.invoiceNumber);

    // No lleva recargo, no se rectifica y no se emite.
    await request(app.getHttpServer())
      .post(`/invoices/${receipt.id}/late-fee`)
      .set(auth)
      .expect(400);
    await request(app.getHttpServer())
      .post(`/invoices/${receipt.id}/rectify`)
      .set(auth)
      .send({
        rectificationType: 'R4',
        reason: 'x',
        items: [{ description: 'x', quantity: 1, unitPrice: -1, taxRate: 0 }],
      })
      .expect(400);
    expect(contractId).toBeTruthy();
  });

  it('un solo pago por Redsys cobra factura y fianza; el acceso llega con los dos', async () => {
    const { owner, auth, invoice, receipt } = await bookAndSign('bookdepredsys');
    await request(app.getHttpServer())
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

    const redirect = await request(app.getHttpServer())
      .post(`/settings/redsys/invoices/${invoice.id}/redirect`)
      .set(auth)
      .send({})
      .expect(200);
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    );
    const expectedCents = Math.round((Number(invoice.total) + 60) * 100);
    expect(params.DS_MERCHANT_AMOUNT).toBe(String(expectedCents));

    // Antes del pago, sin acceso.
    const customerId = invoice.customerId!;
    expect(await admin.accessCredential.count({ where: { customerId, revokedAt: null } })).toBe(0);

    const order = params.DS_MERCHANT_ORDER as string;
    const notif = encodeMerchantParameters({
      Ds_Order: order,
      Ds_Response: '0000',
      Ds_Amount: String(expectedCents),
    });
    await request(app.getHttpServer())
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: notif,
        Ds_Signature: signRequest(notif, order, TEST_KEY),
      })
      .expect(200);

    const [inv, rec] = await Promise.all([
      admin.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
      admin.invoice.findUniqueOrThrow({ where: { id: receipt.id } }),
    ]);
    expect(inv.status).toBe('paid');
    expect(rec.status).toBe('paid');
    expect(Number(rec.amountPaid)).toBe(60);

    // Acceso emitido (una sola credencial) al quedar pagados los dos.
    let creds = 0;
    for (let i = 0; i < 40 && creds === 0; i++) {
      creds = await admin.accessCredential.count({ where: { customerId, revokedAt: null } });
      if (creds === 0) await new Promise((r) => setTimeout(r, 150));
    }
    expect(creds).toBe(1);
    expect(owner.slug).toBeTruthy();
  });

  it('pagar solo la factura no da acceso; al pagar la fianza sí', async () => {
    const { auth, invoice, receipt } = await bookAndSign('bookdepmanual');
    const customerId = invoice.customerId!;
    await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(invoice.total), methodType: 'cash' })
      .expect(200);
    await new Promise((r) => setTimeout(r, 800));
    expect(await admin.accessCredential.count({ where: { customerId, revokedAt: null } })).toBe(0);

    await request(app.getHttpServer())
      .post(`/invoices/${receipt.id}/mark-paid`)
      .set(auth)
      .send({ amount: 60, methodType: 'cash' })
      .expect(200);
    let creds = 0;
    for (let i = 0; i < 40 && creds === 0; i++) {
      creds = await admin.accessCredential.count({ where: { customerId, revokedAt: null } });
      if (creds === 0) await new Promise((r) => setTimeout(r, 150));
    }
    expect(creds).toBe(1);

    // La fianza cobrada no se reembolsa por la pasarela (se liquida con el contrato).
    const refund = await request(app.getHttpServer())
      .post(`/invoices/${receipt.id}/refund`)
      .set(auth)
      .send({ amount: 60 })
      .expect(400);
    expect(refund.body.code).toBe('invoice_not_refundable');
  });
});
