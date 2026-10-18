import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AccessIntegrationsService } from '../src/modules/access/access-integrations.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import { SignaturesService } from '../src/modules/move-in/signatures.service';
import { JOB_DUNNING_EXECUTE_ACTION } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Un cobro en marcha (adeudo SEPA que liquida en días, remesa sin confirmar) no
 * es un impago: ni se marca vencida, ni se reclama, ni se corta el acceso, ni se
 * cancela la reserva online. Y pagar una factura no devuelve el acceso si
 * quedan otras por las que se cortó.
 */
describe('Cobros en curso frente a impagos (e2e)', () => {
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

  async function issuedInvoice(prefix: string, unitPrice = 100) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const inv = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    return { owner, auth, customerId, invoiceId, tenantId: inv.tenantId };
  }

  async function processingPayment(tenantId: string, invoiceId: string, customerId: string) {
    return admin.payment.create({
      data: {
        tenantId,
        invoiceId,
        customerId,
        amount: 121,
        status: 'processing',
        methodType: 'sepa_debit',
        gateway: 'gocardless',
      },
    });
  }

  it('con un adeudo en curso la factura no vence ni se ejecutan las acciones de impago', async () => {
    const { invoiceId, tenantId, customerId } = await issuedInvoice('inflight-dun');
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(Date.now() - 3 * 86_400_000) },
    });
    const payment = await processingPayment(tenantId, invoiceId, customerId);

    const dunning = app.get(DunningService);
    await dunning.dailyTick();
    expect((await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'issued',
    );

    // Una acción ya programada (p. ej. de antes de domiciliar) se aplaza.
    await admin.invoice.update({ where: { id: invoiceId }, data: { status: 'overdue' } });
    const action = await admin.dunningAction.create({
      data: {
        tenantId,
        invoiceId,
        actionType: 'email_reminder',
        status: 'scheduled',
        scheduledFor: new Date(Date.now() - 60_000),
      },
    });
    await dunning.handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId, actionId: action.id });
    expect((await admin.dunningAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe(
      'scheduled',
    );

    // Si el adeudo falla, al día siguiente sí se ejecuta.
    await admin.payment.update({ where: { id: payment.id }, data: { status: 'failed' } });
    await dunning.handleJob(JOB_DUNNING_EXECUTE_ACTION, { tenantId, actionId: action.id });
    expect((await admin.dunningAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe(
      'executed',
    );
  });

  it('una reserva con el primer pago en curso no caduca', async () => {
    const { invoiceId, tenantId, customerId, auth } = await issuedInvoice('inflight-book');
    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local IF', addressLine1: 'C/ A 1', city: 'Madrid', postalCode: '28001' });
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Pequeño', defaultPriceMonthly: 100 });
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: unitType.body.id,
      code: 'IF-1',
      widthM: 1,
      depthM: 1,
      heightM: 2,
      basePriceMonthly: 100,
    });
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unit.body.id, priceMonthly: 100, startDate: '2026-01-01' });
    expect(contract.status).toBe(201);
    await admin.contract.update({
      where: { id: contract.body.id },
      data: { firstPaymentDeadline: new Date(Date.now() - 60_000) },
    });
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { contractId: contract.body.id },
    });
    await processingPayment(tenantId, invoiceId, customerId);

    await app.get(SignaturesService).expireUnpaidBookings();
    const after = await admin.contract.findUniqueOrThrow({ where: { id: contract.body.id } });
    expect(after.status).not.toBe('cancelled');
  });

  it('pagar una factura no devuelve el acceso si queda otra por la que se cortó', async () => {
    const { owner, auth, invoiceId, tenantId, customerId } = await issuedInvoice('inflight-acc');
    const second = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await request(app.getHttpServer()).post(`/invoices/${second}/issue`).set(auth).expect(200);

    const credential = await admin.accessCredential.create({
      data: {
        tenantId,
        customerId,
        method: 'pin',
        status: 'suspended',
        suspendReason: `dunning:invoice-${invoiceId}`,
        secretPreview: '0000',
      },
    });
    for (const id of [invoiceId, second]) {
      await admin.invoice.update({ where: { id }, data: { status: 'overdue' } });
      await admin.dunningAction.create({
        data: {
          tenantId,
          invoiceId: id,
          actionType: 'access_block',
          status: 'executed',
          scheduledFor: new Date(),
          executedAt: new Date(),
        },
      });
    }

    const access = app.get(AccessIntegrationsService);
    await admin.invoice.update({ where: { id: invoiceId }, data: { status: 'paid' } });
    await access.onInvoicePaid({
      tenantId,
      entityType: 'invoice',
      entityId: invoiceId,
      customerId,
      recipientEmail: null,
      scope: {},
    });
    expect(
      (await admin.accessCredential.findUniqueOrThrow({ where: { id: credential.id } })).status,
    ).toBe('suspended');

    await admin.invoice.update({ where: { id: second }, data: { status: 'paid' } });
    await access.onInvoicePaid({
      tenantId,
      entityType: 'invoice',
      entityId: second,
      customerId,
      recipientEmail: null,
      scope: {},
    });
    expect(
      (await admin.accessCredential.findUniqueOrThrow({ where: { id: credential.id } })).status,
    ).toBe('active');
  });

  it('el recargo por porcentaje se calcula sobre lo pendiente', async () => {
    const { auth, invoiceId } = await issuedInvoice('inflight-fee');
    await request(app.getHttpServer())
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ lateFeeEnabled: true, lateFeeType: 'percentage', lateFeeValue: 10 })
      .expect(200);
    // 121 € de total, 21 € ya cobrados en efectivo → quedan 100 €.
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 21, methodType: 'cash' })
      .expect(200);
    const fee = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/late-fee`)
      .set(auth)
      .expect(200);
    expect(fee.body.total).toBe(10);
  });
});
