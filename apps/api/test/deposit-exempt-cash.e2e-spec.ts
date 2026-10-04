import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Inquilinos sin fianza y fianza cobrada en efectivo en el local: la 1ª factura
 * se paga sola (y da el acceso) y la fianza queda pendiente hasta registrar su
 * cobro desde el contrato.
 */
describe('Fianza: sin fianza y en efectivo (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un inquilino sin fianza crea contratos con fianza 0', async () => {
    const owner = await registerVerifiedUser(app, 'depexempt');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    const patched = await http()
      .patch(`/customers/${customerId}`)
      .set(auth)
      .send({ depositExempt: true })
      .expect(200);
    expect(patched.body.depositExempt).toBe(true);

    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 60,
      depositAmount: 100,
    });
    expect(contract.status).toBe(201);
    expect(contract.body.depositAmount).toBe(0);
  });

  it('fianza en efectivo: el acceso llega con la factura y la fianza se cobra aparte', async () => {
    const owner = await registerVerifiedUser(app, 'depcash');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);
    const today = new Date().toISOString().slice(0, 10);

    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: today,
      priceMonthly: 60,
      depositAmount: 100,
      depositPaymentMethod: 'cash',
    });
    expect(contract.status).toBe(201);
    expect(contract.body.depositPaymentMethod).toBe('cash');
    const contractId = contract.body.id as string;

    // Firma remota → 1ª factura + justificante de fianza fuera del pago online.
    const reqSig = await http().post(`/contracts/${contractId}/request-signature`).set(auth);
    const url = reqSig.body.signingUrl as string;
    const token = url.slice(url.indexOf('/sign/') + '/sign/'.length);
    const view = await http().get(`/public/move-in/sign/${token}`).expect(200);
    expect(view.body.depositPaymentMethod).toBe('cash');
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({ signerName: 'Ana', method: 'typed', typedSignature: 'Ana', accept: true })
      .expect(201);

    const docs = await admin.invoice.findMany({
      where: { contractId },
      select: { id: true, kind: true, bundledWithInvoiceId: true, dueDate: true, total: true },
    });
    const invoice = docs.find((d) => d.kind === 'invoice')!;
    const receipt = docs.find((d) => d.kind === 'deposit_receipt')!;
    expect(receipt.bundledWithInvoiceId).toBeNull();
    expect(receipt.dueDate).toBeNull();

    // Pagar solo la factura da el acceso.
    await http()
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(invoice.total), methodType: 'cash' })
      .expect(200);
    let creds = 0;
    for (let i = 0; i < 40 && creds === 0; i++) {
      creds = await admin.accessCredential.count({ where: { customerId, revokedAt: null } });
      if (creds === 0) await new Promise((r) => setTimeout(r, 150));
    }
    expect(creds).toBe(1);

    // La fianza sale en «Hoy» hasta registrar su cobro.
    const before = await http().get('/dashboard/today').set(auth).expect(200);
    expect(before.body.depositsToCollect.count).toBe(1);
    expect(before.body.depositsToCollect.items[0].linkId).toBe(contractId);

    // Ya firmado no se puede cambiar el modo.
    const lock = await http()
      .put(`/contracts/${contractId}/deposit-payment-method`)
      .set(auth)
      .send({ method: 'online' });
    expect(lock.status).toBe(400);

    const collected = await http()
      .post(`/contracts/${contractId}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    expect(collected.body.depositReceipt).toMatchObject({ id: receipt.id, status: 'paid' });
    const after = await http().get('/dashboard/today').set(auth).expect(200);
    expect(after.body.depositsToCollect.count).toBe(0);
    await http().post(`/contracts/${contractId}/deposit/collect`).set(auth).send({}).expect(409);

    // Contrato firmado en el panel (sin justificante): registrar el cobro lo crea.
    const panel = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[1],
      startDate: today,
      priceMonthly: 40,
      depositAmount: 80,
    });
    await http().post(`/contracts/${panel.body.id}/sign`).set(auth).expect(200);
    const viaPanel = await http()
      .post(`/contracts/${panel.body.id}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'bank_transfer' })
      .expect(200);
    expect(viaPanel.body.depositReceipt.status).toBe('paid');
    const pay = await admin.payment.findFirst({
      where: { invoiceId: viaPanel.body.depositReceipt.id },
      select: { amount: true, methodType: true },
    });
    expect(Number(pay?.amount)).toBe(80);
    expect(pay?.methodType).toBe('bank_transfer');
  }, 60_000);
});
