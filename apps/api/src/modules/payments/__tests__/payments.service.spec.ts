import { PaymentsService } from '../payments.service';

import type { AuditService } from '../../auth/audit.service';
import type { PrismaService } from '../../database/prisma.service';
import type { PaymentGateway } from '../payment-gateway.interface';
import type { PaymentMethodsService } from '../payment-methods.service';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const PAYMENT_ID = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
const INVOICE_ID = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';
const GATEWAY_PAYMENT_ID = 'pi_3QxTest123';

interface TxMock {
  payment: { findFirst: jest.Mock; update: jest.Mock };
  invoice: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
}

function buildTx(): TxMock {
  return {
    payment: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue(undefined) },
    invoice: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function buildService(tx: TxMock) {
  const prisma = {
    withTenant: jest.fn((fn: (tx: TxMock) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return new PaymentsService(
    prisma,
    audit,
    null as unknown as PaymentMethodsService,
    null as unknown as PaymentGateway,
  );
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    tenantId: TENANT,
    invoiceId: INVOICE_ID,
    amount: 80,
    refundedAmount: 0,
    status: 'processing',
    gatewayPaymentId: GATEWAY_PAYMENT_ID,
    ...overrides,
  };
}

describe('PaymentsService.syncFromWebhook (idempotencia)', () => {
  it('primera transicion a succeeded actualiza el payment y suma amountPaid (marca paid si cubre el total)', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'processing' }));
    tx.invoice.findUniqueOrThrow.mockResolvedValue({
      id: INVOICE_ID,
      total: 100,
      amountPaid: 20,
    });
    const service = buildService(tx);

    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'succeeded',
      paidAt: new Date('2026-06-11T10:00:00.000Z'),
    });

    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAYMENT_ID },
        data: expect.objectContaining({ status: 'succeeded' }),
      }),
    );
    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_ID },
        data: expect.objectContaining({ amountPaid: 100, status: 'paid' }),
      }),
    );
  });

  it('webhook succeeded duplicado (payment ya succeeded) es no-op: no vuelve a sumar amountPaid', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'succeeded' }));
    const service = buildService(tx);

    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'succeeded',
      paidAt: new Date(),
    });

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('payment_failed que llega despues de succeeded (desordenado) no degrada el payment', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'succeeded' }));
    const service = buildService(tx);

    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'failed',
      failureReason: 'card_declined',
    });

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('transicion a failed desde processing actualiza el payment sin tocar la invoice', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'processing' }));
    const service = buildService(tx);

    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'failed',
      failureReason: 'insufficient_funds',
    });

    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          failureReason: 'insufficient_funds',
        }),
      }),
    );
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('payment desconocido es no-op (solo warn, sin lanzar)', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(null);
    const service = buildService(tx);

    await expect(
      service.syncFromWebhook({
        tenantId: TENANT,
        gatewayPaymentId: 'pi_desconocido',
        newStatus: 'succeeded',
      }),
    ).resolves.toBeUndefined();

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.syncRefundFromWebhook (charge.refunded)', () => {
  it('refund total: marca el payment refunded y propaga el delta a la invoice', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'succeeded' }));
    tx.invoice.findUniqueOrThrow.mockResolvedValue({
      id: INVOICE_ID,
      total: 100,
      amountPaid: 100,
      amountRefunded: 0,
    });
    const service = buildService(tx);

    await service.syncRefundFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      amountRefunded: 80, // acumulado = amount del payment → refund total
    });

    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAYMENT_ID },
        data: expect.objectContaining({ status: 'refunded', refundedAmount: 80 }),
      }),
    );
    // El payment de 80 sobre una invoice de 100 → partially_refunded.
    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_ID },
        data: expect.objectContaining({ amountRefunded: 80, status: 'partially_refunded' }),
      }),
    );
  });

  it('refund parcial: payment pasa a partially_refunded', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'succeeded' }));
    tx.invoice.findUniqueOrThrow.mockResolvedValue({
      id: INVOICE_ID,
      total: 100,
      amountPaid: 100,
      amountRefunded: 0,
    });
    const service = buildService(tx);

    await service.syncRefundFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      amountRefunded: 30,
    });

    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'partially_refunded', refundedAmount: 30 }),
      }),
    );
    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountRefunded: 30, status: 'partially_refunded' }),
      }),
    );
  });

  it('webhook duplicado (acumulado ya registrado) es no-op', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'refunded', refundedAmount: 80 }));
    const service = buildService(tx);

    await service.syncRefundFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      amountRefunded: 80,
    });

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('el acumulado de la invoice se capa en el total (refund externo ya registrado a mano)', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'succeeded' }));
    // El operador ya registro 50 a mano via /invoices/:id/refund.
    tx.invoice.findUniqueOrThrow.mockResolvedValue({
      id: INVOICE_ID,
      total: 100,
      amountPaid: 100,
      amountRefunded: 50,
    });
    const service = buildService(tx);

    await service.syncRefundFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      amountRefunded: 80,
    });

    // 50 + 80 = 130 → capado a 100 y marcado refunded.
    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountRefunded: 100, status: 'refunded' }),
      }),
    );
  });
});
