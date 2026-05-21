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
// API key scopes (enforced en `ApiKeyGuard` desde el sub-bloque 15A.3).
// ============================================================================

/**
 * Scopes ofrecibles al usuario al crear una API key. La autoridad final vive
 * en `apps/api/src/modules/integrations/api-key-scopes.ts` (`API_KEY_SCOPES`);
 * esta lista DEBE mantenerse sincronizada con aquella.
 *
 * El backend acepta tambien el wildcard interno `'*'` (no listado aqui) para
 * keys creadas sin scopes explicitos: el cliente nunca lo manda.
 */
export const ApiKeyScopes = [
  'invoices:read',
  'invoices:write',
  'contracts:read',
  'customers:read',
  'webhooks:trigger',
] as const;
export type ApiKeyScope = (typeof ApiKeyScopes)[number];

export const ApiKeyScopeEnum = z.enum(ApiKeyScopes);

// ============================================================================
// API keys
// ============================================================================

/**
 * `scopes` es opcional: si el body lo omite o lo manda vacio, el backend
 * normaliza a `['*']` (acceso total) para mantener compat con integraciones
 * creadas antes del enforcement. Si se incluye, cada elemento debe estar en
 * `ApiKeyScopes`.
 */
export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(ApiKeyScopeEnum).optional(),
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
