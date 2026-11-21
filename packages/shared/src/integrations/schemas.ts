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
  'invoice.issued',
  /** Antiguo nombre de `invoice.issued` (se envía al emitir, no al crear el borrador). */
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
  'contract.signed',
  'contract.move_out_requested',
  'contract.ended',
  'booking.created',
  'payment.failed',
  'lead.created',
] as const;
export type WebhookEventType = (typeof WebhookEventTypes)[number];

/** Los que se ofrecen al crear un webhook (sin el nombre antiguo). */
export const OFFERED_WEBHOOK_EVENTS = WebhookEventTypes.filter((e) => e !== 'invoice.created');

/** Qué significa cada evento, para la pantalla de integraciones. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  'invoice.issued': 'Factura emitida',
  'invoice.created': 'Factura emitida (nombre antiguo)',
  'invoice.paid': 'Factura cobrada',
  'invoice.overdue': 'Factura vencida',
  'contract.signed': 'Contrato firmado',
  'contract.move_out_requested': 'Baja pedida por el inquilino',
  'contract.ended': 'Contrato terminado',
  'booking.created': 'Reserva online',
  'payment.failed': 'Cobro rechazado',
  'lead.created': 'Contacto nuevo',
};

/** Qué lleva cada aviso, en una frase (ayuda al elegir los eventos). */
export const WEBHOOK_EVENT_HINTS: Record<WebhookEventType, string> = {
  'invoice.issued': 'Cada factura que se emite, con su número e importe.',
  'invoice.created': 'Igual que «Factura emitida» (nombre antiguo).',
  'invoice.paid': 'Cuando una factura queda cobrada del todo.',
  'invoice.overdue': 'Cuando una factura pasa su vencimiento sin cobrarse.',
  'contract.signed': 'Cuando se firma un contrato.',
  'contract.move_out_requested': 'Cuando un inquilino pide la baja desde su área de clientes.',
  'contract.ended': 'Cuando un contrato termina o se cancela estando en vigor.',
  'booking.created': 'Cada reserva hecha desde tu web o el área de clientes.',
  'payment.failed': 'Cuando el banco o la pasarela rechazan un cobro automático.',
  'lead.created': 'Cada contacto nuevo (web, widget, WhatsApp…).',
};

export const WebhookEventTypeEnum = z.enum(WebhookEventTypes);

/**
 * Evento de prueba: `ping` (solo comprueba que llega) o cualquiera de los
 * ofrecidos, con datos de ejemplo. El cuerpo lleva `test: true`.
 */
export const WebhookTestEventEnum = z.enum(['ping', ...OFFERED_WEBHOOK_EVENTS] as [
  'ping',
  ...WebhookEventType[],
]);
export type WebhookTestEvent = z.infer<typeof WebhookTestEventEnum>;

export const TestWebhookSchema = z.object({
  event: WebhookTestEventEnum.optional(),
});
export type TestWebhookInput = z.infer<typeof TestWebhookSchema>;

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
