import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  VERSION_NEUTRAL,
  forwardRef,
} from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { BillingSaasService } from '../billing-saas/billing-saas.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { PAYMENT_GATEWAY, PaymentGateway, WebhookEvent } from './payment-gateway.interface';
import { PaymentsService } from './payments.service';
import { StripeEventsService } from './stripe-events.service';

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
// Webhook montado fuera del versioning: Stripe tiene la URL `/webhooks/stripe`
// registrada en su dashboard. Cambiarla rompe los eventos en produccion.
@Controller({ path: 'webhooks', version: VERSION_NEUTRAL })
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    @Inject(forwardRef(() => BillingSaasService))
    private readonly saasBilling: BillingSaasService,
    private readonly stripeEvents: StripeEventsService,
    private readonly adminPrisma: PrismaAdminService,
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

    // Dedup: Stripe entrega at-least-once, asi que reintentos y duplicados
    // (incluso concurrentes) son normales. Solo la primera entrega de cada
    // `event.id` procesa; el resto se descarta aqui.
    const firstDelivery = await this.stripeEvents.markProcessed(event.id, event.type);
    if (!firstDelivery) {
      this.logger.log(`Evento Stripe duplicado descartado: ${event.id} (${event.type})`);
      return { received: true };
    }

    try {
      await this.dispatch(event);
    } catch (err) {
      // Liberar el event.id para que el retry de Stripe no sea descartado
      // como duplicado y pueda reprocesar.
      await this.stripeEvents.release(event.id);
      throw err;
    }
    return { received: true };
  }

  private async dispatch(event: WebhookEvent): Promise<void> {
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
        // Refund hecho en el gateway (tipicamente dashboard de Stripe):
        // sincronizamos payment + invoice para que no queden como `paid`.
        const charge = (event.data as { object: StripeChargeLike }).object;
        const intentId = stringId(charge.payment_intent);
        if (!intentId) {
          this.logger.warn(`charge.refunded sin payment_intent (event ${event.id})`);
          break;
        }
        // El metadata del charge hereda el del PaymentIntent, pero por si
        // acaso resolvemos el tenant buscando el payment por gateway id.
        const resolvedTenantId = tenantId ?? (await this.lookupTenantByPaymentIntent(intentId));
        if (!resolvedTenantId) {
          this.logger.warn(
            `charge.refunded sin tenant resoluble (event ${event.id}, intent ${intentId})`,
          );
          break;
        }
        await this.payments.syncRefundFromWebhook({
          tenantId: resolvedTenantId,
          gatewayPaymentId: intentId,
          amountRefunded: (charge.amount_refunded ?? 0) / 100,
        });
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
  }

  /** Saca tenantId del `metadata` del objeto Stripe si esta presente. */
  private extractTenantId(data: Record<string, unknown>): string | null {
    const obj = (data as { object?: { metadata?: Record<string, string> } }).object;
    return obj?.metadata?.tenantId ?? null;
  }

  /**
   * Fallback cuando el objeto Stripe no trae `metadata.tenantId`: resuelve
   * el tenant buscando el payment por `gatewayPaymentId`. Necesita el
   * cliente admin (bypass RLS) porque aqui aun no hay tenant context.
   */
  private async lookupTenantByPaymentIntent(intentId: string): Promise<string | null> {
    const payment = await this.adminPrisma.payment.findFirst({
      where: { gatewayPaymentId: intentId },
      select: { tenantId: true },
    });
    return payment?.tenantId ?? null;
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

interface StripeChargeLike {
  id: string;
  payment_intent: string | { id: string } | null;
  /** Acumulado reembolsado en centimos (Stripe siempre manda el total). */
  amount_refunded?: number;
  metadata?: Record<string, string>;
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
