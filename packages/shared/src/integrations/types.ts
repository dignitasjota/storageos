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
