import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Anti-doble-cobro: marcar pagado a mano se bloquea si hay un adeudo SEPA/tarjeta
 * en curso (salvo marca explícita); los pagos parciales solo se admiten en efectivo.
 */
describe('Guard de pago en vuelo + parciales solo efectivo (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('bloquea mark-paid con adeudo SEPA en curso (salvo override) y parciales no-efectivo', async () => {
    const owner = await registerVerifiedUser(app, 'inflight');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    // Factura emitida de 100 €.
    const inv = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    await request(app.getHttpServer()).post(`/invoices/${inv}/issue`).set(auth).expect(200);

    // Simulamos un adeudo GoCardless en curso (processing) sobre la factura.
    await admin.payment.create({
      data: {
        tenantId: owner.tenantId,
        invoiceId: inv,
        customerId,
        amount: 121,
        currency: 'EUR',
        status: 'processing',
        methodType: 'sepa_debit',
        gateway: 'gocardless',
      },
    });

    // Marcar pagado a mano SIN override → 409 (evita el doble cobro).
    const blocked = await request(app.getHttpServer())
      .post(`/invoices/${inv}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('gateway_payment_in_progress');

    // Con marca explícita "pagar de otra forma" → se registra.
    const forced = await request(app.getHttpServer())
      .post(`/invoices/${inv}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash', overridePaymentInFlight: true });
    expect(forced.status).toBe(200);
    expect(forced.body.status).toBe('paid');

    // Segunda factura: pago PARCIAL solo en efectivo.
    const inv2 = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    await request(app.getHttpServer()).post(`/invoices/${inv2}/issue`).set(auth).expect(200);

    // Parcial por transferencia → 400 (parciales solo efectivo).
    const partialBank = await request(app.getHttpServer())
      .post(`/invoices/${inv2}/mark-paid`)
      .set(auth)
      .send({ amount: 50, methodType: 'bank_transfer' });
    expect(partialBank.status).toBe(400);
    expect(partialBank.body.code).toBe('partial_only_cash');

    // Parcial en efectivo → OK (queda parcialmente pagada, sigue issued/overdue).
    const partialCash = await request(app.getHttpServer())
      .post(`/invoices/${inv2}/mark-paid`)
      .set(auth)
      .send({ amount: 50, methodType: 'cash' });
    expect(partialCash.status).toBe(200);
    expect(['issued', 'overdue']).toContain(partialCash.body.status);
  });
});
