import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator';
import { PaymentsService } from '../payments.service';

import { verifyGoCardlessSignature } from './gocardless-client';
import { GoCardlessSettingsService } from './gocardless-settings.service';

import type { Request } from 'express';

interface GoCardlessWebhookEvent {
  id?: string;
  resource_type?: string;
  action?: string;
  links?: { payment?: string };
}

/**
 * Webhook público de GoCardless. La URL lleva el `:tenantId` porque GoCardless
 * no incluye el tenant en el payload y cada tenant tiene su propio webhook
 * secret: cada uno configura en su dashboard la URL
 * `/webhooks/gocardless/<su-tenant-id>`. Necesita el raw body para verificar la
 * firma (`Webhook-Signature`); se registra `express.raw` en `main.ts`.
 *
 * Fase 1: recepción + verificación de firma. El despacho de eventos (mandates /
 * payments → PaymentsService) llega con el cobro por GoCardless (fase posterior).
 */
@Controller({ path: 'webhooks', version: VERSION_NEUTRAL })
export class GoCardlessWebhookController {
  private readonly logger = new Logger(GoCardlessWebhookController.name);

  constructor(
    private readonly settings: GoCardlessSettingsService,
    private readonly payments: PaymentsService,
  ) {}

  @Public()
  @Post('gocardless/:tenantId')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    const signature = req.header('webhook-signature');
    const rawBody = (req as unknown as { body: Buffer }).body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw body no disponible; configurar middleware');
    }

    const resolved = await this.settings.getResolved(tenantId);
    if (!resolved?.webhookSecret) {
      // Tenant desconocido o sin webhook secret configurado.
      throw new BadRequestException('Webhook de GoCardless no configurado');
    }
    if (!verifyGoCardlessSignature(rawBody, signature, resolved.webhookSecret)) {
      this.logger.warn(`Firma de GoCardless inválida (tenant ${tenantId})`);
      throw new BadRequestException('Firma inválida');
    }

    const events =
      (JSON.parse(rawBody.toString('utf8')) as { events?: GoCardlessWebhookEvent[] }).events ?? [];
    this.logger.log(
      `Webhook GoCardless verificado (tenant ${tenantId}): ${events.length} evento(s)`,
    );

    for (const ev of events) {
      if (ev.resource_type !== 'payments') continue;
      const paymentId = ev.links?.payment;
      if (!paymentId) continue;
      if (ev.action === 'confirmed' || ev.action === 'paid_out') {
        // El cobro se ha hecho efectivo → marca la factura pagada (idempotente).
        await this.payments.syncFromWebhook({
          tenantId,
          gatewayPaymentId: paymentId,
          newStatus: 'succeeded',
          paidAt: new Date(),
        });
      } else if (
        ev.action === 'failed' ||
        ev.action === 'cancelled' ||
        ev.action === 'customer_approval_denied'
      ) {
        await this.payments.syncFromWebhook({
          tenantId,
          gatewayPaymentId: paymentId,
          newStatus: 'failed',
          failureReason: `gocardless:${ev.action}`,
        });
      } else if (ev.action === 'charged_back') {
        // Devolución SEPA tras un cobro ya confirmado: revierte el payment
        // `succeeded` → `failed`, resta el `amountPaid` y devuelve la factura a
        // `overdue`/`issued` (idempotente; reusa el mismo flujo que los disputes
        // de Stripe).
        await this.payments.syncDisputeFromWebhook({
          tenantId,
          gatewayPaymentId: paymentId,
          reason: 'charged_back',
        });
      }
    }
    return { received: true };
  }
}
