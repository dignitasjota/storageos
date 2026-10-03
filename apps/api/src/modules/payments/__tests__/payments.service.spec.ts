import { PaymentsService } from '../payments.service';

import type { AuditService } from '../../auth/audit.service';
import type { PrismaService } from '../../database/prisma.service';
import type { GoCardlessChargeService } from '../gocardless/gocardless-charge.service';
import type { PaymentGateway } from '../payment-gateway.interface';
import type { PaymentMethodsService } from '../payment-methods.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const PAYMENT_ID = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
const INVOICE_ID = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';
const GATEWAY_PAYMENT_ID = 'pi_3QxTest123';

interface TxMock {
  payment: {
    findFirst: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  invoice: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  paymentMethod: { findFirst: jest.Mock; findUniqueOrThrow: jest.Mock };
  sepaRemittanceItem: { findFirst: jest.Mock };
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
}

/** ¿Cumple el estado la condición `where.status` de Prisma (igual, in, notIn)? */
function matchesStatus(status: string, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (typeof cond === 'string') return status === cond;
  const c = cond as { in?: string[]; notIn?: string[] };
  if (c.in) return c.in.includes(status);
  if (c.notIn) return !c.notIn.includes(status);
  return true;
}

function buildTx(): TxMock {
  const tx: TxMock = {
    payment: {
      findFirst: jest.fn(),
      // Lectura fresca con la fila bloqueada: la misma fila que `findFirst`.
      findUniqueOrThrow: jest.fn((): unknown => tx.payment.findFirst()),
      // Los webhooks buscan el grupo de pagos del mismo cargo (factura + fianza).
      findMany: jest.fn(async (): Promise<unknown[]> => {
        const row = (await tx.payment.findFirst()) as unknown;
        return row ? [row] : [];
      }),
      update: jest.fn().mockResolvedValue(undefined),
      // Transición condicionada (como en Postgres): solo cuenta si la fila actual
      // cumple `where.status`.
      updateMany: jest.fn(async ({ where }: { where: { status?: unknown } }) => {
        const row = (await tx.payment.findFirst()) as { status?: string } | null;
        return { count: row && matchesStatus(row.status ?? '', where.status) ? 1 : 0 };
      }),
      create: jest.fn(),
      // `assertNoPaymentInFlight` (anti-doble-cobro del portal): sin cobro en
      // vuelo por defecto para que `chargeInvoice` prosiga en los casos base.
      count: jest.fn().mockResolvedValue(0),
    },
    invoice: {
      findFirst: jest.fn(),
      // Justificantes de fianza que se cobran junto a la factura: ninguno por defecto.
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    paymentMethod: { findFirst: jest.fn(), findUniqueOrThrow: jest.fn() },
    // Guard de remesa SEPA sin confirmar: por defecto la factura no está en ninguna.
    sepaRemittanceItem: { findFirst: jest.fn().mockResolvedValue(null) },
    // Advisory lock (`pg_advisory_xact_lock`) del guard anti-doble-cobro.
    $executeRaw: jest.fn().mockResolvedValue(1),
    // `SELECT … FOR UPDATE` de las filas bloqueadas.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return tx;
}

function buildService(
  tx: TxMock,
  deps: {
    gateway?: { charge: jest.Mock };
    paymentMethods?: { decryptToken: jest.Mock; cardPaymentsEnabled?: boolean };
    goCardlessCharge?: { charge: jest.Mock };
    events?: { emit: jest.Mock };
  } = {},
) {
  const prisma = {
    withTenant: jest.fn((fn: (tx: TxMock) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return new PaymentsService(
    prisma,
    audit,
    (deps.paymentMethods ?? null) as unknown as PaymentMethodsService,
    (deps.gateway ?? null) as unknown as PaymentGateway,
    (deps.goCardlessCharge ?? { charge: jest.fn() }) as unknown as GoCardlessChargeService,
    (deps.events ?? { emit: jest.fn() }) as unknown as EventEmitter2,
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
  it('un cobro que se resuelve rechazado emite payment_failed con un motivo legible', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(
      paymentRow({ status: 'processing', customerId: 'cust-1' }),
    );
    const events = { emit: jest.fn() };
    const service = buildService(tx, { events });

    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'failed',
      failureReason: 'insufficient_funds',
    });
    expect(events.emit).toHaveBeenCalledWith('domain.payment_failed', {
      tenantId: TENANT,
      invoiceId: INVOICE_ID,
      customerId: 'cust-1',
      amount: 80,
      reason: 'fondos insuficientes',
    });
  });

  it('primera transicion a succeeded actualiza el payment y suma amountPaid (marca paid si cubre el total)', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'processing' }));
    // El increment atómico devuelve el nuevo total (amountPaid 20 + 80 = 100).
    tx.invoice.update.mockResolvedValue({ amountPaid: 100, total: 100 });
    const service = buildService(tx);

    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'succeeded',
      paidAt: new Date('2026-06-11T10:00:00.000Z'),
    });

    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PAYMENT_ID }),
        data: expect.objectContaining({ status: 'succeeded' }),
      }),
    );
    // 1er update: increment atómico del amountPaid.
    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_ID },
        data: expect.objectContaining({ amountPaid: { increment: 80 } }),
      }),
    );
    // 2º: como cubre el total, marca la factura pagada (solo si no lo estaba).
    expect(tx.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_ID, status: { in: ['issued', 'overdue'] } },
        data: expect.objectContaining({ status: 'paid' }),
      }),
    );
  });

  it('al pasar la factura a pagada emite invoice_paid (y no si ya estaba pagada)', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'processing' }));
    tx.invoice.update.mockResolvedValue({ amountPaid: 100, total: 100 });
    tx.invoice.findFirst.mockResolvedValue({
      invoiceNumber: 'F-2026-0001',
      total: 100,
      paidAt: new Date(),
      customerId: 'cust-1',
      customer: { email: 'inq@example.com' },
    });
    const events = { emit: jest.fn() };
    const service = buildService(tx, { events });

    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'succeeded',
    });
    expect(events.emit).toHaveBeenCalledWith(
      'domain.invoice_paid',
      expect.objectContaining({
        entityId: INVOICE_ID,
        customerId: 'cust-1',
        recipientEmail: 'inq@example.com',
      }),
    );

    events.emit.mockClear();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'processing' }));
    tx.invoice.updateMany.mockResolvedValue({ count: 0 });
    await service.syncFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      newStatus: 'succeeded',
    });
    expect(events.emit).not.toHaveBeenCalled();
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

    expect(tx.payment.updateMany).toHaveBeenCalledWith(
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

describe('PaymentsService.chargeInvoice (SEPA)', () => {
  const PM_ID = '019e3d20-eeee-7c2f-bf37-6511065b9fc5';
  const CUSTOMER_ID = '019e3d20-ffff-7c2f-bf37-6511065b9fc5';
  const meta = {};

  function issuedInvoice() {
    return {
      id: INVOICE_ID,
      customerId: CUSTOMER_ID,
      customer: { id: CUSTOMER_ID },
      status: 'issued',
      invoiceNumber: 'FA/2026/00001',
      total: 100,
      amountPaid: 0,
      currency: 'EUR',
    };
  }

  function createdPaymentRow(status: string) {
    return {
      id: PAYMENT_ID,
      invoiceId: INVOICE_ID,
      customerId: CUSTOMER_ID,
      paymentMethodId: PM_ID,
      amount: 100,
      currency: 'EUR',
      status,
      methodType: 'sepa_debit',
      gateway: 'stripe',
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      paidAt: null,
      refundedAt: null,
      refundedAmount: 0,
      failureReason: null,
      createdAt: new Date('2026-06-11T10:00:00.000Z'),
      invoice: { invoiceNumber: 'FA/2026/00001' },
      customer: {
        firstName: 'Ana',
        lastName: 'García',
        companyName: null,
        customerType: 'individual',
      },
    };
  }

  it('PM sepa_debit: pasa paymentMethodType al gateway y deja el payment processing sin tocar la invoice', async () => {
    const tx = buildTx();
    tx.invoice.findFirst.mockResolvedValue(issuedInvoice());
    tx.paymentMethod.findUniqueOrThrow.mockResolvedValue({
      id: PM_ID,
      type: 'sepa_debit',
      gateway: 'stripe',
      gatewayCustomerId: 'cus_123',
    });
    // FASE 1 reserva el payment (select id); FASE 3 lo finaliza con una
    // transición condicionada (processing → estado final) y relee la fila.
    tx.payment.create.mockResolvedValue({ id: PAYMENT_ID });
    tx.payment.findFirst.mockResolvedValue(createdPaymentRow('processing'));
    const gateway = {
      charge: jest.fn().mockResolvedValue({
        gatewayPaymentId: GATEWAY_PAYMENT_ID,
        status: 'processing', // SEPA: el banco liquida en dias, no en el request
      }),
    };
    const paymentMethods = {
      decryptToken: jest.fn().mockResolvedValue('pm_sepa_token'),
      cardPaymentsEnabled: true,
    };
    const service = buildService(tx, { gateway, paymentMethods });

    const dto = await service.chargeInvoice({
      tenantId: TENANT,
      userId: 'user-1',
      invoiceId: INVOICE_ID,
      input: { paymentMethodId: PM_ID },
      meta,
    });

    expect(gateway.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodType: 'sepa_debit',
        paymentMethodToken: 'pm_sepa_token',
        amountCents: 10_000,
        offSession: true,
      }),
    );
    // #3 (anti-cargo-huérfano): la reserva se crea `processing` ANTES de cobrar.
    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'processing', methodType: 'sepa_debit' }),
      }),
    );
    // FASE 3 actualiza la reserva con el resultado del gateway.
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PAYMENT_ID }),
        data: expect.objectContaining({
          status: 'processing',
          gatewayPaymentId: GATEWAY_PAYMENT_ID,
        }),
      }),
    );
    // processing NO suma a amountPaid: eso llega via webhook al liquidar.
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(dto.status).toBe('processing');
  });

  it('#3: si el gateway LANZA, la reserva se marca failed (sin cargo huérfano) y se relanza', async () => {
    const tx = buildTx();
    tx.invoice.findFirst.mockResolvedValue(issuedInvoice());
    tx.paymentMethod.findUniqueOrThrow.mockResolvedValue({
      id: PM_ID,
      type: 'card',
      gateway: 'stripe',
      gatewayCustomerId: 'cus_123',
    });
    tx.payment.create.mockResolvedValue({ id: PAYMENT_ID });
    const gateway = { charge: jest.fn().mockRejectedValue(new Error('network down')) };
    const paymentMethods = {
      decryptToken: jest.fn().mockResolvedValue('pm_token'),
      cardPaymentsEnabled: true,
    };
    const service = buildService(tx, { gateway, paymentMethods });

    await expect(
      service.chargeInvoice({
        tenantId: TENANT,
        userId: 'user-1',
        invoiceId: INVOICE_ID,
        input: { paymentMethodId: PM_ID },
        meta,
      }),
    ).rejects.toThrow('network down');

    // La reserva creada ANTES del cargo se marca failed (libera el slot); nunca
    // queda un cargo real sin registro (el registro existe desde FASE 1).
    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'processing' }) }),
    );
    // La reserva (y las de la fianza cobrada junto, si las hubiera) pasa a failed.
    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [PAYMENT_ID] } },
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('PM no cobrable (cash) devuelve 400 payment_method_not_chargeable sin llamar al gateway', async () => {
    const tx = buildTx();
    tx.invoice.findFirst.mockResolvedValue(issuedInvoice());
    tx.paymentMethod.findUniqueOrThrow.mockResolvedValue({
      id: PM_ID,
      type: 'cash',
      gateway: 'manual',
      gatewayCustomerId: null,
    });
    const gateway = { charge: jest.fn() };
    const service = buildService(tx, {
      gateway,
      paymentMethods: { decryptToken: jest.fn() },
    });

    await expect(
      service.chargeInvoice({
        tenantId: TENANT,
        userId: 'user-1',
        invoiceId: INVOICE_ID,
        input: { paymentMethodId: PM_ID },
        meta,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'payment_method_not_chargeable' }),
    });
    expect(gateway.charge).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.syncDisputeFromWebhook (devoluciones SEPA)', () => {
  it('revierte un payment succeeded: failed + resta amountPaid y la invoice paid vuelve a overdue', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'succeeded', amount: 100 }));
    tx.invoice.findUniqueOrThrow.mockResolvedValue({
      id: INVOICE_ID,
      status: 'paid',
      total: 100,
      amountPaid: 100,
      dueDate: new Date('2026-05-01T00:00:00.000Z'), // ya vencida
    });
    const service = buildService(tx);

    await service.syncDisputeFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
      reason: 'debit_not_authorized',
    });

    expect(tx.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PAYMENT_ID }),
        data: expect.objectContaining({
          status: 'failed',
          failureReason: 'disputed: debit_not_authorized',
        }),
      }),
    );
    expect(tx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INVOICE_ID },
        data: expect.objectContaining({ amountPaid: 0, status: 'overdue', paidAt: null }),
      }),
    );
  });

  it('dispute duplicado (payment ya failed) es no-op: no resta dos veces', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(paymentRow({ status: 'failed' }));
    const service = buildService(tx);

    await service.syncDisputeFromWebhook({
      tenantId: TENANT,
      gatewayPaymentId: GATEWAY_PAYMENT_ID,
    });

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('payment desconocido es no-op (solo warn)', async () => {
    const tx = buildTx();
    tx.payment.findFirst.mockResolvedValue(null);
    const service = buildService(tx);

    await expect(
      service.syncDisputeFromWebhook({
        tenantId: TENANT,
        gatewayPaymentId: 'pi_desconocido',
      }),
    ).resolves.toBeUndefined();

    expect(tx.payment.update).not.toHaveBeenCalled();
  });
});
