import { InvoicesService } from '../invoices.service';

import type { AuditService } from '../../auth/audit.service';
import type { PrismaService } from '../../database/prisma.service';
import type { PaymentGateway } from '../../payments/payment-gateway.interface';

/**
 * Refund REAL vía pasarela (bug de dinero): el botón «Reembolsar» solo tocaba
 * la BD; el dinero nunca salía de Stripe. Ahora, si el pago tiene
 * `gatewayPaymentId`, se llama a `gateway.refund` y se actualiza
 * `payment.refundedAmount` para que el webhook `charge.refunded` no doble-cuente.
 */

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const INVOICE = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';

/** Fila de factura suficiente para `toDto`. */
function invoiceRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-05-01T00:00:00.000Z');
  return {
    id: INVOICE,
    invoiceNumber: 'A-1',
    seriesId: 'series-1',
    series: { code: 'A' },
    sequenceNumber: 1,
    customerId: 'cust-1',
    customer: null,
    contractId: null,
    contract: null,
    status: 'paid',
    invoiceType: 'F1',
    rectifiesInvoiceId: null,
    rectifiesInvoice: null,
    lateFeeForInvoiceId: null,
    lateFeeInvoice: null,
    rectificationReason: null,
    correctionMethod: null,
    issueDate: now,
    dueDate: now,
    periodStart: null,
    periodEnd: null,
    subtotal: 100,
    taxAmount: 0,
    total: 100,
    amountPaid: 100,
    amountRefunded: 0,
    currency: 'EUR',
    pdfUrl: null,
    notes: null,
    hash: 'h',
    previousHash: null,
    qrCodeUrl: null,
    verifactuMode: 'verifactu',
    aeatSentAt: null,
    aeatStatus: null,
    aeatCsv: null,
    holdedDocumentId: null,
    paidAt: now,
    cancelledAt: null,
    items: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildService(deps: {
  gatewayPayment: Record<string, unknown> | null;
  gatewayRefund?: jest.Mock;
}) {
  const tx = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue(invoiceRow()),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(invoiceRow(data)),
        ),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(deps.gatewayPayment),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const prisma = {
    withTenant: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const gateway = {
    refund: deps.gatewayRefund ?? jest.fn(),
  } as unknown as PaymentGateway;
  const service = new InvoicesService(
    prisma,
    audit,
    null as never,
    null as never,
    null as never,
    null as never,
    gateway,
  );
  return { service, tx, gateway };
}

describe('InvoicesService.refund — reembolso real vía pasarela', () => {
  it('con pago de pasarela: llama a gateway.refund y actualiza payment.refundedAmount (anti-doble-cómputo)', async () => {
    const gatewayRefund = jest
      .fn()
      .mockResolvedValue({ gatewayRefundId: 're_1', status: 'succeeded' });
    const { service, tx } = buildService({
      gatewayPayment: {
        id: 'pay-1',
        gatewayPaymentId: 'pi_x',
        gateway: 'stripe',
        amount: 100,
        refundedAmount: 0,
        status: 'succeeded',
      },
      gatewayRefund,
    });

    const result = await service.refund({
      tenantId: TENANT,
      userId: 'user-1',
      invoiceId: INVOICE,
      input: { amount: 50, reason: 'descuento' },
      meta: {},
    });

    // Devolvió el dinero DE VERDAD (50 € → 5000 céntimos).
    expect(gatewayRefund).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPaymentId: 'pi_x', amountCents: 5000 }),
    );
    // Actualizó payment.refundedAmount → el webhook posterior no doble-cuenta.
    expect(tx.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-1' },
        data: expect.objectContaining({ refundedAmount: 50, status: 'partially_refunded' }),
      }),
    );
    expect(result.status).toBe('partially_refunded');
  });

  it('sin pago de pasarela (cobro manual): NO llama al gateway, solo actualiza la factura', async () => {
    const gatewayRefund = jest.fn();
    const { service, tx } = buildService({ gatewayPayment: null, gatewayRefund });

    await service.refund({
      tenantId: TENANT,
      userId: 'user-1',
      invoiceId: INVOICE,
      input: { amount: 30 },
      meta: {},
    });

    expect(gatewayRefund).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountRefunded: 30 }) }),
    );
  });

  it('si la pasarela rechaza el reembolso: lanza y NO toca la BD', async () => {
    const gatewayRefund = jest
      .fn()
      .mockResolvedValue({ gatewayRefundId: 're_2', status: 'failed' });
    const { service, tx } = buildService({
      gatewayPayment: {
        id: 'pay-1',
        gatewayPaymentId: 'pi_x',
        gateway: 'stripe',
        amount: 100,
        refundedAmount: 0,
        status: 'succeeded',
      },
      gatewayRefund,
    });

    await expect(
      service.refund({
        tenantId: TENANT,
        userId: 'user-1',
        invoiceId: INVOICE,
        input: { amount: 50 },
        meta: {},
      }),
    ).rejects.toMatchObject({ response: { code: 'gateway_refund_failed' } });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('cobro por GoCardless: 400 claro (no llama a Stripe) en vez de un 500', async () => {
    const gatewayRefund = jest.fn();
    const { service, tx } = buildService({
      gatewayPayment: {
        id: 'pay-1',
        gatewayPaymentId: 'PM-gc-1',
        gateway: 'gocardless',
        amount: 100,
        refundedAmount: 0,
        status: 'succeeded',
      },
      gatewayRefund,
    });

    await expect(
      service.refund({
        tenantId: TENANT,
        userId: 'user-1',
        invoiceId: INVOICE,
        input: { amount: 50 },
        meta: {},
      }),
    ).rejects.toMatchObject({ response: { code: 'refund_not_supported_gateway' } });
    expect(gatewayRefund).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});
