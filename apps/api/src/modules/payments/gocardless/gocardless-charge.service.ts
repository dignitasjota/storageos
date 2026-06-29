import { Injectable, Logger } from '@nestjs/common';

import { GoCardlessClient } from './gocardless-client';
import { GoCardlessSettingsService } from './gocardless-settings.service';

import type { ChargeResult } from '../payment-gateway.interface';

/**
 * Cobro de una factura por GoCardless: crea un Payment contra el mandato. El
 * cobro SEPA queda `processing` (liquidación en días); el resultado definitivo
 * (`payments.confirmed`/`failed`) llega por webhook y lo aplica
 * `PaymentsService.syncFromWebhook`.
 *
 * No depende de `PaymentsService`/`PaymentMethodsService` (vive en el módulo
 * core de GoCardless): así `PaymentsModule` lo puede importar sin ciclo.
 */
@Injectable()
export class GoCardlessChargeService {
  private readonly logger = new Logger(GoCardlessChargeService.name);

  constructor(
    private readonly client: GoCardlessClient,
    private readonly settings: GoCardlessSettingsService,
  ) {}

  async charge(args: {
    tenantId: string;
    /** Id del mandato de GoCardless (el token descifrado del PaymentMethod). */
    mandateId: string;
    amountCents: number;
    currency: string;
    description: string;
    metadata?: Record<string, string>;
  }): Promise<ChargeResult> {
    const resolved = await this.settings.getResolved(args.tenantId);
    if (!resolved?.enabled) {
      return {
        gatewayPaymentId: `gc_failed_${args.mandateId}`,
        status: 'failed',
        failureReason: 'gocardless_not_enabled',
      };
    }
    try {
      const res = await this.client.createPayment(resolved.accessToken, resolved.environment, {
        mandateId: args.mandateId,
        amountCents: args.amountCents,
        currency: args.currency,
        description: args.description,
        ...(args.metadata ? { metadata: args.metadata } : {}),
      });
      // pending_submission/submitted → processing; los estados terminales
      // (raros tan pronto) se mapean directamente.
      const status: ChargeResult['status'] =
        res.status === 'confirmed' || res.status === 'paid_out'
          ? 'succeeded'
          : res.status === 'failed' ||
              res.status === 'cancelled' ||
              res.status === 'customer_approval_denied'
            ? 'failed'
            : 'processing';
      return { gatewayPaymentId: res.id, status };
    } catch (err) {
      this.logger.warn(
        `Cobro GoCardless falló (tenant ${args.tenantId}): ${(err as Error).message}`,
      );
      return {
        gatewayPaymentId: `gc_failed_${args.mandateId}`,
        status: 'failed',
        failureReason: (err as Error).message,
      };
    }
  }
}
