import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../../../common/decorators/public.decorator';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PaymentsService, paymentIdsFromMetadata } from '../payments.service';
import { StripeEventsService } from '../stripe-events.service';

import { accountState, StripeConnectClient } from './stripe-connect.client';
import { StripeConnectService } from './stripe-connect.service';

import type { Env } from '../../../config/env.schema';
import type { Request } from 'express';

interface ConnectEvent {
  id: string;
  type: string;
  /** Cuenta conectada a la que pertenece el evento. */
  account?: string;
  data: { object: Record<string, unknown> };
}

/**
 * Webhook de las cuentas conectadas de Stripe (cobros de los tenants a sus
 * inquilinos). Distinto del de la plataforma (`/webhooks/stripe`, que cobra las
 * suscripciones): en Stripe es un endpoint de tipo «Connect» con su propio
 * secreto (`STRIPE_CONNECT_WEBHOOK_SECRET`). El tenant sale de la cuenta del
 * evento (`event.account`), nunca de los metadatos del cobro.
 */
@Controller({ path: 'webhooks', version: VERSION_NEUTRAL })
export class StripeConnectWebhookController {
  private readonly logger = new Logger(StripeConnectWebhookController.name);
  private readonly secret: string;

  constructor(
    private readonly client: StripeConnectClient,
    private readonly connect: StripeConnectService,
    private readonly payments: PaymentsService,
    private readonly events: StripeEventsService,
    private readonly admin: PrismaAdminService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('STRIPE_CONNECT_WEBHOOK_SECRET', { infer: true });
  }

  @Public()
  @Post('stripe-connect')
  @HttpCode(HttpStatus.OK)
  async handle(@Req() req: Request): Promise<{ received: true }> {
    const signature = req.header('stripe-signature');
    if (!signature) throw new BadRequestException('stripe-signature header ausente');
    const rawBody = (req as unknown as { body: Buffer }).body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw body no disponible; configurar middleware');
    }
    let event: ConnectEvent;
    try {
      event = this.client.sdk.webhooks.constructEvent(
        rawBody,
        signature,
        this.secret,
      ) as unknown as ConnectEvent;
    } catch (err) {
      this.logger.warn(`Firma de Stripe Connect inválida: ${(err as Error).message}`);
      throw new BadRequestException('Firma invalida');
    }

    if (!(await this.events.markProcessed(event.id, event.type))) {
      return { received: true };
    }
    try {
      await this.dispatch(event);
    } catch (err) {
      await this.events.release(event.id);
      throw err;
    }
    return { received: true };
  }

  private async dispatch(event: ConnectEvent): Promise<void> {
    const accountId = event.account;
    if (!accountId) {
      this.logger.warn(`Evento de Stripe Connect sin cuenta (${event.id}, ${event.type})`);
      return;
    }
    const obj = event.data.object;

    if (event.type === 'account.updated') {
      await this.connect.saveState(accountId, accountState(obj));
      return;
    }
    if (event.type === 'account.application.deauthorized') {
      await this.connect.forgetAccount(accountId);
      return;
    }

    const linked = await this.admin.tenantStripeAccount.findUnique({
      where: { stripeAccountId: accountId },
      select: { tenantId: true },
    });
    if (!linked) {
      this.logger.warn(`Cuenta de Stripe ${accountId} sin tenant (${event.type})`);
      return;
    }
    const tenantId = linked.tenantId;

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.payments.syncFromWebhook({
          tenantId,
          gatewayPaymentId: String(obj.id),
          newStatus: 'succeeded',
          paidAt: new Date(),
          paymentIdsHint: paymentIdsFromMetadata(obj.metadata),
        });
        break;
      case 'payment_intent.payment_failed': {
        const err = obj.last_payment_error as { message?: string } | null | undefined;
        await this.payments.syncFromWebhook({
          tenantId,
          gatewayPaymentId: String(obj.id),
          newStatus: 'failed',
          ...(err?.message ? { failureReason: err.message } : {}),
          paymentIdsHint: paymentIdsFromMetadata(obj.metadata),
        });
        break;
      }
      case 'charge.refunded': {
        const intentId = refId(obj.payment_intent);
        if (!intentId) break;
        await this.payments.syncRefundFromWebhook({
          tenantId,
          gatewayPaymentId: intentId,
          amountRefunded: Number(obj.amount_refunded ?? 0) / 100,
        });
        break;
      }
      case 'charge.dispute.created': {
        const intentId = refId(obj.payment_intent);
        if (!intentId) break;
        await this.payments.syncDisputeFromWebhook({
          tenantId,
          gatewayPaymentId: intentId,
          ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
        });
        break;
      }
      default:
        this.logger.debug(`Evento de Stripe Connect sin handler: ${event.type}`);
    }
  }
}

function refId(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}
