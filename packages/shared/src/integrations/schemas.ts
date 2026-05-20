import { z } from 'zod';

// ============================================================================
// Webhook event types (whitelist).
// ============================================================================

/**
 * Eventos suscribibles via webhook. Mantener sincronizado con
 * `apps/api/src/modules/integrations/webhook-events.ts` (mapping a
 * `DOMAIN_EVENTS`).
 */
export const WebhookEventTypes = [
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
  'contract.signed',
  'lead.created',
] as const;
export type WebhookEventType = (typeof WebhookEventTypes)[number];

export const WebhookEventTypeEnum = z.enum(WebhookEventTypes);

// ============================================================================
// API key scopes (informativo en MVP).
// ============================================================================

/**
 * Scopes documentados para API keys. En MVP NO se enforcing en el guard:
 * cualquier token activo accede a los endpoints `/v1/integrations/*`. La
 * granularidad real llega en el sub-bloque 14B (permission sets).
 */
export const ApiKeyScopes = [
  'invoices:read',
  'invoices:write',
  'customers:read',
  'customers:write',
  'contracts:read',
  'contracts:write',
  'leads:read',
  'leads:write',
] as const;
export type ApiKeyScope = (typeof ApiKeyScopes)[number];

export const ApiKeyScopeEnum = z.enum(ApiKeyScopes);

// ============================================================================
// API keys
// ============================================================================

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(ApiKeyScopeEnum).default([]),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

// ============================================================================
// Webhooks
// ============================================================================

export const WebhookUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((u) => u.startsWith('https://') || u.startsWith('http://'), {
    message: 'La URL debe empezar por http:// o https://',
  });

export const CreateWebhookSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: WebhookUrlSchema,
  events: z.array(WebhookEventTypeEnum).min(1, 'Selecciona al menos un evento'),
});
export type CreateWebhookInput = z.infer<typeof CreateWebhookSchema>;

export const UpdateWebhookSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: WebhookUrlSchema.optional(),
    events: z.array(WebhookEventTypeEnum).min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookSchema>;
