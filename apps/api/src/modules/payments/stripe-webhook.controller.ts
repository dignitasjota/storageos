import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import { PaymentsService } from './payments.service';

import type { Request } from 'express';

/**
 * Endpoint publico que recibe eventos de Stripe. La verificacion de
 * firma se hace con el header `Stripe-Signature` + `STRIPE_WEBHOOK_SECRET`.
 *
 * Necesita el raw body para verificar la firma. Configuramos
 * `app.use('/webhooks/stripe', express.raw(...))` en `main.ts`.
 *
 * Eventos manejados:
 *   - payment_intent.succeeded / payment_intent.payment_failed
 *   - charge.refunded
 *   - setup_intent.succeeded (solo log)
 *   - customer.deleted (limpia payment_methods relacionados)
 */
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
  ) {}

  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request): Promise<{ received: true }> {
    const signature = req.header('stripe-signature');
    if (!signature) {
      throw new BadRequestException('stripe-signature header ausente');
    }
    // Express raw middleware (main.ts) deja el buffer en req.body.
    const rawBody = (req as unknown as { body: Buffer }).body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw body no disponible; configurar middleware');
    }

    let event;
    try {
      event = this.gateway.verifyWebhook(rawBody, signature);
    } catch (err) {
      this.logger.warn(`Firma de Stripe invalida: ${(err as Error).message}`);
      throw new BadRequestException('Firma invalida');
    }

    // El metadata.tenantId fue setado al crear el PaymentIntent.
    const tenantId = this.extractTenantId(event.data);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = (event.data as { object: { id: string } }).object;
        if (tenantId) {
          await this.payments.syncFromWebhook({
            tenantId,
            gatewayPaymentId: intent.id,
            newStatus: 'succeeded',
            paidAt: new Date(),
          });
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const intent = (
          event.data as {
            object: { id: string; last_payment_error?: { message?: string } };
          }
        ).object;
        if (tenantId) {
          await this.payments.syncFromWebhook({
            tenantId,
            gatewayPaymentId: intent.id,
            newStatus: 'failed',
            ...(intent.last_payment_error?.message
              ? { failureReason: intent.last_payment_error.message }
              : {}),
          });
        }
        break;
      }
      case 'charge.refunded': {
        // Sincronizacion mas detallada se hace via endpoint refund manual;
        // aqui solo logueamos.
        this.logger.log(`charge.refunded recibido (event ${event.id})`);
        break;
      }
      case 'customer.deleted':
      case 'setup_intent.succeeded':
        // No-op (los manejamos sincronamente al registrar el metodo).
        break;
      default:
        this.logger.debug(`Evento Stripe sin handler: ${event.type}`);
    }
    return { received: true };
  }

  /** Saca tenantId del `metadata` del objeto Stripe si esta presente. */
  private extractTenantId(data: Record<string, unknown>): string | null {
    const obj = (data as { object?: { metadata?: Record<string, string> } }).object;
    return obj?.metadata?.tenantId ?? null;
  }
}
