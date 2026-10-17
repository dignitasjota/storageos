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
  /** Stripe Connect: cuenta conectada del tenant donde se crea el cliente. */
  stripeAccount?: string;
}

export interface CreateCustomerResult {
  gatewayCustomerId: string;
}

export interface CreateSetupIntentParams {
  gatewayCustomerId: string;
  /** Stripe Connect: cuenta conectada del tenant. */
  stripeAccount?: string;
  /** Tipos admitidos (por defecto tarjeta e IBAN). */
  paymentMethodTypes?: ChargeablePaymentMethodType[];
}

export interface CreateSetupIntentResult {
  clientSecret: string;
  setupIntentId: string;
}

/** Tipos de payment method cobrables via gateway (los demas son manuales). */
export type ChargeablePaymentMethodType = 'card' | 'sepa_debit';

export interface ChargeParams {
  gatewayCustomerId: string;
  paymentMethodToken: string;
  /**
   * Tipo del payment method guardado. Stripe exige que el PaymentIntent
   * declare `payment_method_types` compatible (su default es solo
   * `['card']`, asi que un cobro SEPA sin esto falla).
   */
  paymentMethodType: ChargeablePaymentMethodType;
  amountCents: number;
  currency: string;
  /** Texto descriptivo (factura, contrato). Aparece en el extracto del cliente. */
  description: string;
  metadata: Record<string, string>;
  /** Si true, el gateway intenta confirmar inmediatamente sin SCA. */
  offSession: boolean;
  /** Stripe Connect: el cobro se hace en la cuenta conectada del tenant. */
  stripeAccount?: string;
  /** Stripe Connect: comisión de la plataforma (céntimos). */
  applicationFeeCents?: number;
  /** Evita un segundo cargo si la petición se repite. */
  idempotencyKey?: string;
}

export interface ChargeResult {
  /** Id del cobro en la pasarela; vacío si no se sabe (`unknown` sin respuesta). */
  gatewayPaymentId: string;
  /**
   * `unknown`: la pasarela no respondió (corte de red, error del servidor) y no
   * se sabe si cobró. El pago queda en curso hasta que se aclare (webhook,
   * notificación o el repaso de cobros sin resolver): no es un rechazo y no se
   * puede volver a cobrar mientras tanto.
   */
  status: 'succeeded' | 'processing' | 'failed' | 'requires_action' | 'unknown';
  failureReason?: string;
}

/** Estado de un cobro consultado en la pasarela. */
export interface GatewayChargeLookup {
  gatewayPaymentId: string;
  status: 'succeeded' | 'processing' | 'failed' | 'requires_action';
  failureReason?: string;
  metadata: Record<string, string>;
}

export interface RefundParams {
  gatewayPaymentId: string;
  amountCents: number;
  reason?: string;
  /**
   * Clave de idempotencia: dos peticiones con la misma clave devuelven el mismo
   * reembolso en vez de devolver el dinero dos veces (doble clic, reintento).
   */
  idempotencyKey?: string;
  /** Stripe Connect: cuenta conectada donde se hizo el cobro (devuelve también la comisión). */
  stripeAccount?: string;
}

export interface RefundResult {
  gatewayRefundId: string;
  status: 'succeeded' | 'processing' | 'failed';
}

export interface PaymentMethodDetails {
  /**
   * Tipo real del payment method segun el gateway (`null` si es un tipo
   * que no mapeamos). El registro DEBE preferir esto al `type` que mande
   * el cliente: es la fuente de verdad.
   */
  type: ChargeablePaymentMethodType | null;
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
  abstract getPaymentMethodDetails(
    paymentMethodToken: string,
    stripeAccount?: string,
  ): Promise<PaymentMethodDetails>;
  /** Verifica la firma de un webhook + parsea el evento. */
  abstract verifyWebhook(rawBody: Buffer, signatureHeader: string): WebhookEvent;

  /**
   * Busca un cobro por su id en la pasarela o, si no se llegó a conocer, por
   * nuestro id de pago (metadato `paymentId`). null si no existe.
   */
  findCharge(_args: {
    paymentId: string;
    gatewayPaymentId: string | null;
    stripeAccount?: string;
  }): Promise<GatewayChargeLookup | null> {
    return Promise.resolve(null);
  }

  /** Cancela un cobro que no se completó (p. ej. pendiente de autenticación). */
  cancelCharge(_args: { gatewayPaymentId: string; stripeAccount?: string }): Promise<void> {
    return Promise.resolve();
  }
}

export interface WebhookEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  livemode: boolean;
  created: number;
}

export const PAYMENT_GATEWAY = Symbol('PaymentGateway');
