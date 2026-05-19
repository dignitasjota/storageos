/**
 * Interfaz que abstrae el gateway de pagos. Permite que `PaymentsService`
 * trabaje con cualquier proveedor (Stripe en Fase 4; GoCardless / Redsys
 * en fases siguientes) sin acoplarse a su SDK.
 *
 * Diseño: methods sincronos en la capa de aplicacion (charge, refund)
 * + webhooks asincronos para sincronizar el resultado definitivo. El
 * gateway NUNCA escribe directamente en BD; devuelve el resultado al
 * service que lo aplica.
 */

export interface CreateCustomerParams {
  /** Email visible en el dashboard del gateway (no usado para auth). */
  email: string | null;
  /** Nombre visible. */
  name: string;
  /** Metadatos a embedded en el objeto del gateway. */
  metadata: Record<string, string>;
}

export interface CreateCustomerResult {
  gatewayCustomerId: string;
}

export interface CreateSetupIntentParams {
  gatewayCustomerId: string;
}

export interface CreateSetupIntentResult {
  clientSecret: string;
  setupIntentId: string;
}

export interface ChargeParams {
  gatewayCustomerId: string;
  paymentMethodToken: string;
  amountCents: number;
  currency: string;
  /** Texto descriptivo (factura, contrato). Aparece en el extracto del cliente. */
  description: string;
  metadata: Record<string, string>;
  /** Si true, el gateway intenta confirmar inmediatamente sin SCA. */
  offSession: boolean;
}

export interface ChargeResult {
  gatewayPaymentId: string;
  status: 'succeeded' | 'processing' | 'failed' | 'requires_action';
  failureReason?: string;
}

export interface RefundParams {
  gatewayPaymentId: string;
  amountCents: number;
  reason?: string;
}

export interface RefundResult {
  gatewayRefundId: string;
  status: 'succeeded' | 'processing' | 'failed';
}

export interface PaymentMethodDetails {
  last4: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  /** sepa_debit -> mandate reference; null para tarjeta. */
  mandateReference: string | null;
}

export abstract class PaymentGateway {
  abstract readonly providerName: 'stripe' | 'gocardless' | 'redsys';

  abstract createCustomer(args: CreateCustomerParams): Promise<CreateCustomerResult>;
  abstract createSetupIntent(args: CreateSetupIntentParams): Promise<CreateSetupIntentResult>;
  abstract charge(args: ChargeParams): Promise<ChargeResult>;
  abstract refund(args: RefundParams): Promise<RefundResult>;
  /** Lee metadatos del payment_method tras un setup intent confirmado. */
  abstract getPaymentMethodDetails(paymentMethodToken: string): Promise<PaymentMethodDetails>;
  /** Verifica la firma de un webhook + parsea el evento. */
  abstract verifyWebhook(rawBody: Buffer, signatureHeader: string): WebhookEvent;
}

export interface WebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  livemode: boolean;
  created: number;
}

export const PAYMENT_GATEWAY = Symbol('PaymentGateway');
