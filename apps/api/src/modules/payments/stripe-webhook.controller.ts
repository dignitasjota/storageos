import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  forwardRef,
} from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { BillingSaasService } from '../billing-saas/billing-saas.service';

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
    @Inject(forwardRef(() => BillingSaasService))
    private readonly saasBilling: BillingSaasService,
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
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = (event.data as { object: StripeSubscriptionLike }).object;
        const { periodStart, periodEnd } = extractSubscriptionPeriod(sub);
        await this.saasBilling.syncSubscriptionFromStripe({
          stripeSubscriptionId: sub.id,
          stripeCustomerId:
            typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? ''),
          tenantIdHint: sub.metadata?.tenantId ?? null,
          status: sub.status,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          planIdHint: sub.metadata?.planId ?? null,
        });
        break;
      }
      case 'invoice.payment_succeeded': {
        const inv = (event.data as { object: StripeInvoiceLike }).object;
        // Las facturas SaaS las gestiona Stripe entero; aqui solo loggeamos.
        // El cambio de status real llega via `customer.subscription.updated`.
        if (inv.subscription) {
          this.logger.log(
            `invoice.payment_succeeded recibido (event ${event.id}, sub ${stringId(inv.subscription)})`,
          );
        }
        break;
      }
      case 'invoice.payment_failed': {
        const inv = (event.data as { object: StripeInvoiceLike }).object;
        if (inv.subscription) {
          await this.saasBilling.recordInvoicePaymentFailed({
            stripeCustomerId: stringId(inv.customer) ?? '',
            stripeSubscriptionId: stringId(inv.subscription),
            tenantIdHint: inv.metadata?.tenantId ?? null,
          });
        }
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

// ---------------------------------------------------------------------------
// Tipos minimos para tipar los objetos Stripe sin acoplar el controller al SDK.
// El parsing real ya lo hizo `verifyWebhook`; aqui solo describimos los
// campos que nos interesan.
// ---------------------------------------------------------------------------

interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  // En Stripe API 2025+ `current_period_*` ya no esta top-level: vive en cada
  // item de `items.data[]`. Conservamos los top-level como fallback por si la
  // cuenta esta en una version antigua.
  current_period_start?: number;
  current_period_end?: number;
  items?: {
    data?: Array<{
      current_period_start?: number;
      current_period_end?: number;
    }>;
  };
}

interface StripeInvoiceLike {
  id: string;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  metadata?: Record<string, string>;
}

function extractSubscriptionPeriod(sub: StripeSubscriptionLike): {
  periodStart: number;
  periodEnd: number;
} {
  // Preferimos el item porque es la fuente actual de la API.
  const item = sub.items?.data?.[0];
  const periodStart = item?.current_period_start ?? sub.current_period_start ?? 0;
  const periodEnd = item?.current_period_end ?? sub.current_period_end ?? 0;
  return { periodStart, periodEnd };
}

function stringId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.id;
}
