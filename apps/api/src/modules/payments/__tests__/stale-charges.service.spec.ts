import { StaleChargesService } from '../stale-charges.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { PaymentGateway } from '../payment-gateway.interface';
import type { PaymentsService } from '../payments.service';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const P1 = '019e3d20-1111-7c2f-bf37-6511065b9fc5';
const P2 = '019e3d20-2222-7c2f-bf37-6511065b9fc5';
const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';

function row(minutesAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    id: P1,
    tenantId: TENANT,
    invoiceId: 'inv-1',
    status: 'processing',
    gatewayPaymentId: null,
    stripeAccountId: 'acct_1',
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    ...overrides,
  };
}

function build(rows: unknown[], found: unknown, orders: unknown[] = []) {
  const admin = {
    payment: {
      findMany: jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    redsysOrder: {
      findMany: jest.fn().mockResolvedValue(orders),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const payments = { syncFromWebhook: jest.fn().mockResolvedValue(undefined) };
  const gateway = {
    findCharge: jest.fn().mockResolvedValue(found),
    cancelCharge: jest.fn().mockResolvedValue(undefined),
  };
  const service = new StaleChargesService(
    admin as unknown as PrismaAdminService,
    payments as unknown as PaymentsService,
    gateway as unknown as PaymentGateway,
  );
  return { admin, payments, gateway, service };
}

describe('StaleChargesService', () => {
  it('cobro encontrado en Stripe: aplica su estado recuperando el pago por sus metadatos', async () => {
    const { payments, gateway, service } = build([row(20)], {
      gatewayPaymentId: 'pi_ok',
      status: 'succeeded',
      metadata: { paymentId: P1, bundledPaymentIds: P2 },
    });
    const r = await service.run(NOW);
    expect(gateway.findCharge).toHaveBeenCalledWith({
      paymentId: P1,
      gatewayPaymentId: null,
      stripeAccount: 'acct_1',
    });
    expect(payments.syncFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayPaymentId: 'pi_ok',
        newStatus: 'succeeded',
        paymentIdsHint: [P1, P2],
      }),
    );
    expect(r.resolved).toBe(1);
  });

  it('sin rastro en Stripe: espera una hora y luego lo da por no hecho', async () => {
    const early = build([row(20)], null);
    await early.service.run(NOW);
    expect(early.admin.payment.updateMany).not.toHaveBeenCalled();

    const late = build([row(90)], null);
    const r = await late.service.run(NOW);
    expect(late.admin.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'failed', failureReason: 'stripe_no_charge' },
      }),
    );
    expect(r.failed).toBe(1);
  });

  it('pendiente de autenticación: se cancela en Stripe y queda fallido', async () => {
    const { payments, gateway, service } = build(
      [row(60 * 30, { status: 'pending', gatewayPaymentId: 'pi_3ds' })],
      { gatewayPaymentId: 'pi_3ds', status: 'requires_action', metadata: {} },
    );
    await service.run(NOW);
    expect(gateway.cancelCharge).toHaveBeenCalledWith({
      gatewayPaymentId: 'pi_3ds',
      stripeAccount: 'acct_1',
    });
    expect(payments.syncFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPaymentId: 'pi_3ds', newStatus: 'failed' }),
    );
  });

  it('orden de Redsys sin respuesta en 24 h: caduca y su pago queda fallido', async () => {
    const { admin, service } = build([], null, [{ order: '1234AB', tenantId: TENANT }]);
    const r = await service.run(NOW);
    expect(admin.redsysOrder.updateMany).toHaveBeenCalledWith({
      where: { order: '1234AB', status: 'charging' },
      data: { status: 'expired' },
    });
    expect(admin.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ gateway: 'redsys', gatewayPaymentId: '1234AB' }),
        data: { status: 'failed', failureReason: 'redsys_no_response' },
      }),
    );
    expect(r.expiredRedsysOrders).toBe(1);
  });
});
