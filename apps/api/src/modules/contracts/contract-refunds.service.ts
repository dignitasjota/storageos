import { Injectable, Logger } from '@nestjs/common';

import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { RequestMeta } from '../auth/auth.service';

/**
 * Devoluciones al deshacer un contrato antes de tiempo (cancelar una reserva
 * antes de la apertura, desistir en los 14 días): lo que se puede devolver
 * desde la app y lo que tiene que devolver el equipo a mano.
 */
@Injectable()
export class ContractRefundsService {
  private readonly logger = new Logger(ContractRefundsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly invoices: InvoicesService,
  ) {}

  /**
   * Devuelve lo cobrado de una factura (o del justificante de fianza): por la
   * pasarela si se cobró con tarjeta o domiciliación (`gateway`); si no
   * (efectivo, transferencia, pago con tarjeta en la página del banco) queda
   * registrado y lo devuelve el equipo (`manual`). Un cobro automático con la
   * tarjeta guardada en Redsys no se puede devolver desde la app: no se toca, se
   * devuelve desde el TPV y se registra después en la factura (`bank`).
   */
  async refundDocument(
    args: { tenantId: string; userId: string | null; meta: RequestMeta },
    invoiceId: string,
    amount: number,
    reason: string,
    deposit = false,
  ): Promise<'gateway' | 'manual' | 'bank'> {
    const gateway = await this.admin.payment.findFirst({
      where: {
        invoiceId,
        gatewayPaymentId: { not: null },
        gateway: { in: ['stripe', 'gocardless'] },
        status: { in: ['succeeded', 'partially_refunded'] },
      },
      select: { id: true },
    });
    try {
      await this.invoices.refund({
        tenantId: args.tenantId,
        userId: args.userId,
        invoiceId,
        input: { amount, reason },
        meta: args.meta,
        ...(deposit ? { allowDepositReceipt: true } : {}),
      });
    } catch (err) {
      const code = (err as { response?: { code?: string } }).response?.code;
      if (code === 'refund_needs_bank') return 'bank';
      throw err;
    }
    return gateway ? 'gateway' : 'manual';
  }

  /** Justificante de fianza sin cobrar: se anula para que no quede como deuda. */
  async cancelUnpaidDeposit(
    tenantId: string,
    contractId: string,
    reason: string,
    args: { userId: string | null; meta: RequestMeta },
  ): Promise<void> {
    const receipts = await this.admin.invoice.findMany({
      where: {
        tenantId,
        contractId,
        kind: 'deposit_receipt',
        status: { in: ['draft', 'issued', 'overdue'] },
        deletedAt: null,
      },
      select: { id: true },
    });
    for (const r of receipts) {
      await this.invoices
        .cancel({
          tenantId,
          userId: args.userId,
          invoiceId: r.id,
          input: { reason },
          meta: args.meta,
        })
        .catch((err: unknown) =>
          this.logger.warn(`fianza ${r.id} sin anular: ${(err as Error).message}`),
        );
    }
  }
}
