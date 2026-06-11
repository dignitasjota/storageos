import { JOB_PAYMENTS_AUTO_CHARGE } from '../../queues/queues.module';
import { AutoChargeService } from '../auto-charge.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { PaymentsService } from '../payments.service';
import type { Queue } from 'bullmq';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const INVOICE_ID = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
const CUSTOMER_ID = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';

interface AdminMock {
  tenant: { findUnique: jest.Mock };
  invoice: { findFirst: jest.Mock };
  paymentMethod: { findFirst: jest.Mock };
}

function buildAdmin(): AdminMock {
  return {
    tenant: { findUnique: jest.fn() },
    invoice: { findFirst: jest.fn() },
    paymentMethod: { findFirst: jest.fn() },
  };
}

function buildService(
  admin: AdminMock,
  deps: { queue?: { add: jest.Mock }; payments?: { chargeInvoice: jest.Mock } } = {},
) {
  const queue = deps.queue ?? { add: jest.fn() };
  const payments = deps.payments ?? { chargeInvoice: jest.fn() };
  const service = new AutoChargeService(
    queue as unknown as Queue,
    admin as unknown as PrismaAdminService,
    payments as unknown as PaymentsService,
  );
  return { service, queue, payments };
}

function issuedEventPayload() {
  return {
    tenantId: TENANT,
    entityType: 'invoice' as const,
    entityId: INVOICE_ID,
    customerId: CUSTOMER_ID,
    scope: {},
  };
}

function chargeableInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: 'issued',
    customerId: CUSTOMER_ID,
    total: 100,
    amountPaid: 0,
    ...overrides,
  };
}

describe('AutoChargeService.onInvoiceIssued (listener)', () => {
  it('con el flag activo encola el job auto-charge', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: true });
    const { service, queue } = buildService(admin);

    await service.onInvoiceIssued(issuedEventPayload());

    expect(queue.add).toHaveBeenCalledWith(JOB_PAYMENTS_AUTO_CHARGE, {
      tenantId: TENANT,
      invoiceId: INVOICE_ID,
    });
  });

  it('con el flag apagado no encola nada', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: false });
    const { service, queue } = buildService(admin);

    await service.onInvoiceIssued(issuedEventPayload());

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('un error en el listener no se propaga (no rompe el issue)', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockRejectedValue(new Error('db down'));
    const { service, queue } = buildService(admin);

    await expect(service.onInvoiceIssued(issuedEventPayload())).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('AutoChargeService.processAutoCharge (job)', () => {
  const jobData = { tenantId: TENANT, invoiceId: INVOICE_ID };

  it('happy path: cobra con chargeInvoice y userId null', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: true });
    admin.invoice.findFirst.mockResolvedValue(chargeableInvoice());
    admin.paymentMethod.findFirst.mockResolvedValue({ id: 'pm-1' });
    const payments = {
      chargeInvoice: jest.fn().mockResolvedValue({ id: 'pay-1', status: 'processing' }),
    };
    const { service } = buildService(admin, { payments });

    const result = await service.processAutoCharge(jobData);

    expect(result).toEqual({ charged: true });
    expect(payments.chargeInvoice).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: null,
      invoiceId: INVOICE_ID,
      input: {},
      meta: {},
    });
  });

  it('flag apagado entre el encolado y el proceso → skip', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: false });
    const { service, payments } = buildService(admin);

    const result = await service.processAutoCharge(jobData);

    expect(result).toEqual({ charged: false, reason: 'flag_disabled' });
    expect(payments.chargeInvoice).not.toHaveBeenCalled();
  });

  it('factura sin customer (F2) → skip', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: true });
    admin.invoice.findFirst.mockResolvedValue(chargeableInvoice({ customerId: null }));
    const { service, payments } = buildService(admin);

    const result = await service.processAutoCharge(jobData);

    expect(result).toEqual({ charged: false, reason: 'no_customer' });
    expect(payments.chargeInvoice).not.toHaveBeenCalled();
  });

  it('factura ya pagada (status paid) → skip', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: true });
    admin.invoice.findFirst.mockResolvedValue(chargeableInvoice({ status: 'paid' }));
    const { service, payments } = buildService(admin);

    const result = await service.processAutoCharge(jobData);

    expect(result).toEqual({ charged: false, reason: 'status_paid' });
    expect(payments.chargeInvoice).not.toHaveBeenCalled();
  });

  it('customer sin metodo de pago default cobrable → skip', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: true });
    admin.invoice.findFirst.mockResolvedValue(chargeableInvoice());
    admin.paymentMethod.findFirst.mockResolvedValue(null);
    const { service, payments } = buildService(admin);

    const result = await service.processAutoCharge(jobData);

    expect(result).toEqual({ charged: false, reason: 'no_payment_method' });
    expect(payments.chargeInvoice).not.toHaveBeenCalled();
  });

  it('un cobro rechazado por el gateway (payment failed) NO lanza', async () => {
    const admin = buildAdmin();
    admin.tenant.findUnique.mockResolvedValue({ autoChargeOnIssue: true });
    admin.invoice.findFirst.mockResolvedValue(chargeableInvoice());
    admin.paymentMethod.findFirst.mockResolvedValue({ id: 'pm-1' });
    const payments = {
      chargeInvoice: jest
        .fn()
        .mockResolvedValue({ id: 'pay-1', status: 'failed', failureReason: 'card_declined' }),
    };
    const { service } = buildService(admin, { payments });

    await expect(service.processAutoCharge(jobData)).resolves.toEqual({ charged: true });
  });
});
