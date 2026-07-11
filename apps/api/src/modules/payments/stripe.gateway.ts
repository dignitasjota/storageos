import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import StripeSDK from 'stripe';

type Stripe = InstanceType<typeof StripeSDK>;
type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'canceled'
  | 'requires_capture';

import {
  type ChargeParams,
  type ChargeResult,
  type CreateCustomerParams,
  type CreateCustomerResult,
  type CreateSetupIntentParams,
  type CreateSetupIntentResult,
  PaymentGateway,
  type PaymentMethodDetails,
  type RefundParams,
  type RefundResult,
  type WebhookEvent,
} from './payment-gateway.interface';

import type { Env } from '../../config/env.schema';

/**
 * Implementacion de PaymentGateway sobre Stripe. Usa el SDK oficial.
 *
 * Para tests usamos un STRIPE_SECRET_KEY=sk_test_dummy + mock de la
 * clase via Nest DI override; el SDK real solo se invoca contra la
 * Stripe API en dev manual y en produccion.
 */
@Injectable()
export class StripeGateway extends PaymentGateway {
  readonly providerName = 'stripe' as const;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly configured: boolean;

  constructor(config: ConfigService<Env, true>) {
    super();
    const apiKey = config.get('STRIPE_SECRET_KEY', { infer: true });
    // Con la clave placeholder de dev/test cualquier llamada a la API fallaría
    // con un 500 opaco: los flujos que tocan Stripe deben cortar antes.
    this.configured = Boolean(apiKey) && apiKey !== 'sk_test_dummy';
    this.stripe = new StripeSDK(apiKey, {
      typescript: true,
      telemetry: false,
    });
    this.webhookSecret = config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
  }

  /** True si hay una clave real de Stripe (no el placeholder de dev/test). */
  isConfigured(): boolean {
    return this.configured;
  }

  async createCustomer(args: CreateCustomerParams): Promise<CreateCustomerResult> {
    const c = await this.stripe.customers.create({
      ...(args.email ? { email: args.email } : {}),
      name: args.name,
      metadata: args.metadata,
    });
    return { gatewayCustomerId: c.id };
  }

  async createSetupIntent(args: CreateSetupIntentParams): Promise<CreateSetupIntentResult> {
    const intent = await this.stripe.setupIntents.create({
      customer: args.gatewayCustomerId,
      usage: 'off_session',
      payment_method_types: ['card', 'sepa_debit'],
    });
    if (!intent.client_secret) {
      throw new Error('Stripe no devolvio client_secret para el setup intent');
    }
    return { clientSecret: intent.client_secret, setupIntentId: intent.id };
  }

  async charge(args: ChargeParams): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: args.amountCents,
        currency: args.currency.toLowerCase(),
        customer: args.gatewayCustomerId,
        payment_method: args.paymentMethodToken,
        // Sin esto Stripe asume ['card'] y rechaza el confirm con un PM
        // sepa_debit. Un cobro SEPA queda en 'processing' hasta que el
        // banco liquida (2-5 dias habiles); el resultado final llega por
        // webhook payment_intent.succeeded/payment_failed.
        payment_method_types: [args.paymentMethodType],
        description: args.description,
        metadata: args.metadata,
        off_session: args.offSession,
        confirm: true,
      });
      return {
        gatewayPaymentId: intent.id,
        status: this.mapIntentStatus(intent.status),
        ...(intent.last_payment_error?.message
          ? { failureReason: intent.last_payment_error.message }
          : {}),
      };
    } catch (err) {
      if (err instanceof StripeSDK.errors.StripeError) {
        const e = err as { payment_intent?: { id?: string }; message: string };
        return {
          gatewayPaymentId: e.payment_intent?.id ?? `pi_failed_${Date.now()}`,
          status: 'failed',
          failureReason: e.message,
        };
      }
      throw err;
    }
  }

  async refund(args: RefundParams): Promise<RefundResult> {
    const r = await this.stripe.refunds.create({
      payment_intent: args.gatewayPaymentId,
      amount: args.amountCents,
      ...(args.reason ? { reason: 'requested_by_customer' } : {}),
    });
    return {
      gatewayRefundId: r.id,
      status:
        r.status === 'succeeded' ? 'succeeded' : r.status === 'pending' ? 'processing' : 'failed',
    };
  }

  async getPaymentMethodDetails(token: string): Promise<PaymentMethodDetails> {
    const pm = await this.stripe.paymentMethods.retrieve(token);
    if (pm.type === 'card' && pm.card) {
      return {
        type: 'card',
        last4: pm.card.last4 ?? null,
        brand: pm.card.brand ?? null,
        expMonth: pm.card.exp_month ?? null,
        expYear: pm.card.exp_year ?? null,
        mandateReference: null,
      };
    }
    if (pm.type === 'sepa_debit' && pm.sepa_debit) {
      return {
        type: 'sepa_debit',
        last4: pm.sepa_debit.last4 ?? null,
        brand: 'sepa',
        expMonth: null,
        expYear: null,
        mandateReference: (pm.sepa_debit as { mandate?: string }).mandate ?? null,
      };
    }
    return {
      type: null,
      last4: null,
      brand: pm.type,
      expMonth: null,
      expYear: null,
      mandateReference: null,
    };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string): WebhookEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    return {
      id: event.id,
      type: event.type,
      data: event.data as unknown as Record<string, unknown>,
      livemode: event.livemode,
      created: event.created,
    };
  }

  /**
   * Devuelve el cliente Stripe SDK crudo. Solo lo usa `BillingSaasService`
   * (Fase 8B) para Checkout Sessions y Billing Portal, que NO encajan en la
   * interfaz `PaymentGateway` (esa abstraccion es para cobrar a inquilinos,
   * no para gestionar la suscripcion del tenant).
   */
  getClient(): Stripe {
    return this.stripe;
  }

  private mapIntentStatus(status: PaymentIntentStatus): ChargeResult['status'] {
    switch (status) {
      case 'succeeded':
        return 'succeeded';
      case 'processing':
        return 'processing';
      case 'requires_action':
      case 'requires_confirmation':
      case 'requires_payment_method':
        return 'requires_action';
      default:
        return 'failed';
    }
  }
}
