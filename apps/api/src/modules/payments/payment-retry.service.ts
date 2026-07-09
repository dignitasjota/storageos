import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { PaymentsService } from './payments.service';

const DAY_MS = 86_400_000;

/**
 * Reintentos de cobro automático (smart retry): reintenta cobrar las facturas
 * VENCIDAS (`overdue`) con método de pago por defecto cobrable, con backoff
 * (un intento cada `interval` días, hasta `max` intentos) antes de dejar que el
 * dunning escale. Recupera cobros que fallaron por un rechazo puntual de la
 * tarjeta/SEPA sin intervención manual. Opt-in por tenant.
 */
@Injectable()
export class PaymentRetryService {
  private readonly logger = new Logger(PaymentRetryService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly payments: PaymentsService,
  ) {}

  async runRetries(): Promise<{ attempted: number; recovered: number }> {
    const tenants = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        autoChargeRetryEnabled: true,
        // El reintento presupone que el cobro automático está activo.
        autoChargeOnIssue: true,
      },
      select: { id: true, autoChargeRetryMax: true, autoChargeRetryIntervalDays: true },
    });

    let attempted = 0;
    let recovered = 0;
    const now = new Date();

    for (const t of tenants) {
      const retryBefore = new Date(now.getTime() - t.autoChargeRetryIntervalDays * DAY_MS);
      const candidates = await this.admin.invoice.findMany({
        where: {
          tenantId: t.id,
          deletedAt: null,
          status: 'overdue',
          customerId: { not: null },
          autoRetryCount: { lt: t.autoChargeRetryMax },
          OR: [{ autoRetryLastAt: null }, { autoRetryLastAt: { lte: retryBefore } }],
        },
        select: { id: true, customerId: true, total: true, amountPaid: true },
        take: 200,
      });

      for (const inv of candidates) {
        if (!inv.customerId) continue;
        if (Number(inv.total) - Number(inv.amountPaid) <= 0) continue;
        // Método de pago por defecto cobrable (card/SEPA); sin él no se cuenta el intento.
        const pm = await this.admin.paymentMethod.findFirst({
          where: {
            tenantId: t.id,
            customerId: inv.customerId,
            isDefault: true,
            type: { in: ['card', 'sepa_debit'] },
          },
        });
        if (!pm) continue;

        // Registrar el intento ANTES de cobrar: si el gateway rechaza (o lanza),
        // el intento ya cuenta y no se reintenta hasta el próximo intervalo.
        await this.admin.invoice.update({
          where: { id: inv.id },
          data: { autoRetryCount: { increment: 1 }, autoRetryLastAt: now },
        });
        attempted++;
        try {
          const payment = await this.payments.chargeInvoice({
            tenantId: t.id,
            userId: null,
            invoiceId: inv.id,
            input: {},
            facilityScope: null,
            meta: {},
          });
          if (payment.status === 'succeeded') recovered++;
        } catch (err) {
          this.logger.log(
            `[payment-retry] invoice ${inv.id} sin cobrar: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return { attempted, recovered };
  }
}
