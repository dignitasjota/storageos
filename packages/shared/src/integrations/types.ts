import type { ApiKeyScope, WebhookEventType } from './schemas';

// ============================================================================
// API key DTOs
// ============================================================================

export interface ApiKeyDto {
  id: string;
  name: string;
  /** `sk_live_<tenantId>` — sin el secret. Visible siempre. */
  keyPrefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdByUserId: string;
}

/**
 * Response al crear/rotar una API key. El campo `keyPlaintext` se devuelve
 * UNA SOLA VEZ y nunca se vuelve a mostrar. Formato:
 *   `sk_live_<tenantId>.<secret>`
 */
export interface ApiKeyWithPlaintextDto extends ApiKeyDto {
  keyPlaintext: string;
}

// ============================================================================
// Webhook DTOs
// ============================================================================

export interface WebhookDto {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  isActive: boolean;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * Response al crear o rotar un webhook. Incluye el `secret` en plaintext
 * UNA SOLA VEZ para que el tenant lo guarde y verifique HMAC al recibir.
 */
export interface WebhookWithSecretDto extends WebhookDto {
  secret: string;
}

export interface WebhookDeliveryDto {
  id: string;
  webhookId: string;
  eventType: WebhookEventType | string;
  payload: Record<string, unknown>;
  signature: string;
  attempts: number;
  status: 'pending' | 'success' | 'failed';
  statusCode: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  scheduledFor: string;
  deliveredAt: string | null;
  createdAt: string;
}

/** Resultado de `POST /settings/webhooks/:id/test`: el envío ya está en la cola. */
export interface WebhookTestResultDto {
  deliveryId: string;
  event: string;
}

// ============================================================================
// API pública de lectura (`/v1/integrations/*`, autenticada con clave de API)
// ============================================================================
//
// Contrato estable para integradores: solo campos útiles, nunca hashes,
// tokens, notas internas ni datos de terceros. Importes en euros con dos
// decimales (`number`), fechas de calendario `YYYY-MM-DD` e instantes ISO.

/** Página por cursor: pasa `nextCursor` como `?cursor=` para la siguiente. */
export interface PublicApiPageDto<T> {
  data: T[];
  nextCursor: string | null;
}

export interface PublicApiCustomerDto {
  id: string;
  type: 'individual' | 'business';
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  /** Nombre para mostrar: razón social o nombre y apellidos. */
  displayName: string;
  email: string | null;
  billingEmail: string | null;
  phone: string | null;
  documentType: string | null;
  documentNumber: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string;
  locale: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicApiContractDto {
  id: string;
  contractNumber: string;
  status: 'draft' | 'active' | 'ending' | 'ended' | 'cancelled';
  customerId: string;
  unitId: string;
  unitCode: string;
  facilityId: string;
  facilityName: string;
  startDate: string;
  endDate: string | null;
  signedAt: string | null;
  endingRequestedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  /** Cuota mensual sin IVA. */
  priceMonthly: number;
  /** Descuento mensual sin IVA. */
  discountAmount: number;
  depositAmount: number;
  depositStatus: string;
  /** Cada cuántos meses se factura (1 = mensual). */
  billingIntervalMonths: number;
  autoRenew: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicApiInvoiceItemDto {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  /** S1 con IVA · E1-E6 exenta · N1/N2 no sujeta. */
  taxCategory: string;
  taxAmount: number;
  total: number;
}

export interface PublicApiInvoiceDto {
  id: string;
  invoiceNumber: string;
  status:
    | 'issued'
    | 'paid'
    | 'overdue'
    | 'cancelled'
    | 'refunded'
    | 'partially_refunded'
    | 'rectified';
  /** F1 completa · F2 simplificada · R1-R5 rectificativa. */
  invoiceType: string;
  /** `invoice` (factura) o `deposit_receipt` (justificante de fianza). */
  kind: string;
  customerId: string | null;
  contractId: string | null;
  rectifiesInvoiceId: string | null;
  issueDate: string | null;
  dueDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  amountRefunded: number;
  withholdingAmount: number;
  /** Lo que queda por cobrar (0 si no está emitida o vencida). */
  amountPending: number;
  currency: string;
  paidAt: string | null;
  items: PublicApiInvoiceItemDto[];
  createdAt: string;
  updatedAt: string;
}
