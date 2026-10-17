import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import { PaymentsService, paymentIdsFromMetadata } from './payments.service';

const MINUTE_MS = 60_000;
/** Margen antes de consultar un cobro sin respuesta (el webhook suele llegar antes). */
export const STALE_LOOKUP_AFTER_MS = 10 * MINUTE_MS;
/** Sin rastro en Stripe pasado este tiempo: el cargo no llegó a hacerse. */
export const STRIPE_NOT_FOUND_AFTER_MS = 60 * MINUTE_MS;
/** Orden de Redsys sin respuesta ni notificación pasado este tiempo: no se cobró. */
export const REDSYS_EXPIRE_AFTER_MS = 24 * 60 * MINUTE_MS;

export interface StaleChargesResult {
  resolved: number;
  failed: number;
  expiredRedsysOrders: number;
}

/**
 * Cierra los cobros que se quedaron «en curso» sin saber su resultado:
 * - Stripe sin respuesta (corte de red, error del servidor): se busca el cobro
 *   por nuestro id de pago; si existe se aplica su estado y si no aparece en
 *   una hora se da por no hecho.
 * - Pagos `pending` antiguos (pendientes de autenticación): se cancelan.
 * - Redsys con tarjeta guardada sin respuesta del banco: si en 24 h no llega la
 *   notificación, la orden se da por no cobrada (si la notificación llega
 *   después, se aplica igualmente y se avisa si sobra dinero).
 * Hasta que se cierran, la factura no se puede volver a cobrar (evita cobrar
 * dos veces lo que quizá ya se cobró).
 */
@Injectable()
export class StaleChargesService {
  private readonly logger = new Logger(StaleChargesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly payments: PaymentsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async run(now = new Date()): Promise<StaleChargesResult> {
    const result: StaleChargesResult = { resolved: 0, failed: 0, expiredRedsysOrders: 0 };
    await this.resolveStripe(now, result);
    await this.expireRedsys(now, result);
    return result;
  }

  private async resolveStripe(now: Date, result: StaleChargesResult): Promise<void> {
    const rows = await this.admin.payment.findMany({
      where: {
        gateway: 'stripe',
        createdAt: { lt: new Date(now.getTime() - STALE_LOOKUP_AFTER_MS) },
        OR: [{ status: 'processing', gatewayPaymentId: null }, { status: 'pending' }],
        // Los justificantes de fianza cobrados junto a su factura se resuelven
        // con el pago de la factura (van en el mismo cargo).
        invoice: { kind: { not: 'deposit_receipt' } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        tenantId: true,
        invoiceId: true,
        status: true,
        gatewayPaymentId: true,
        stripeAccountId: true,
        createdAt: true,
      },
    });
    for (const row of rows) {
      try {
        const found = await this.gateway.findCharge({
          paymentId: row.id,
          gatewayPaymentId: row.gatewayPaymentId,
          ...(row.stripeAccountId ? { stripeAccount: row.stripeAccountId } : {}),
        });
        if (!found) {
          if (now.getTime() - row.createdAt.getTime() < STRIPE_NOT_FOUND_AFTER_MS) continue;
          await this.markFailed(row, 'stripe_no_charge');
          result.failed += 1;
          continue;
        }
        const hint = [...new Set([row.id, ...paymentIdsFromMetadata(found.metadata)])];
        if (found.status === 'requires_action') {
          await this.gateway
            .cancelCharge({
              gatewayPaymentId: found.gatewayPaymentId,
              ...(row.stripeAccountId ? { stripeAccount: row.stripeAccountId } : {}),
            })
            .catch(() => undefined);
        }
        const newStatus =
          found.status === 'requires_action'
            ? 'failed'
            : found.status === 'processing'
              ? 'processing'
              : found.status;
        await this.payments.syncFromWebhook({
          tenantId: row.tenantId,
          gatewayPaymentId: found.gatewayPaymentId,
          newStatus,
          ...(newStatus === 'succeeded' ? { paidAt: new Date() } : {}),
          ...(newStatus === 'failed'
            ? { failureReason: found.failureReason ?? 'authentication_required' }
            : {}),
          paymentIdsHint: hint,
        });
        if (newStatus === 'failed') result.failed += 1;
        else result.resolved += 1;
      } catch (err) {
        this.logger.warn(
          `[stale-charges] pago ${row.id} sin resolver: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Da por no hecho un cargo (y los justificantes que iban en él). */
  private async markFailed(
    row: { id: string; tenantId: string; invoiceId: string | null; createdAt: Date },
    reason: string,
  ): Promise<void> {
    const siblings = row.invoiceId
      ? await this.admin.payment.findMany({
          where: {
            tenantId: row.tenantId,
            gateway: 'stripe',
            status: 'processing',
            gatewayPaymentId: null,
            invoice: { kind: 'deposit_receipt', bundledWithInvoiceId: row.invoiceId },
            createdAt: {
              gte: new Date(row.createdAt.getTime() - MINUTE_MS),
              lte: new Date(row.createdAt.getTime() + MINUTE_MS),
            },
          },
          select: { id: true },
        })
      : [];
    await this.admin.payment.updateMany({
      where: {
        id: { in: [row.id, ...siblings.map((s) => s.id)] },
        status: { in: ['processing', 'pending'] },
      },
      data: { status: 'failed', failureReason: reason },
    });
    this.logger.warn(`[stale-charges] pago ${row.id} sin cargo en la pasarela: ${reason}`);
  }

  private async expireRedsys(now: Date, result: StaleChargesResult): Promise<void> {
    const orders = await this.admin.redsysOrder.findMany({
      where: {
        status: 'charging',
        createdAt: { lt: new Date(now.getTime() - REDSYS_EXPIRE_AFTER_MS) },
      },
      select: { order: true, tenantId: true },
      take: 200,
    });
    for (const o of orders) {
      const { count } = await this.admin.redsysOrder.updateMany({
        where: { order: o.order, status: 'charging' },
        data: { status: 'expired' },
      });
      if (count === 0) continue;
      await this.admin.payment.updateMany({
        where: {
          tenantId: o.tenantId,
          gateway: 'redsys',
          gatewayPaymentId: o.order,
          status: { in: ['processing', 'pending'] },
        },
        data: { status: 'failed', failureReason: 'redsys_no_response' },
      });
      result.expiredRedsysOrders += 1;
    }
  }
}
