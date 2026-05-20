import { DOMAIN_EVENTS } from '../automations/domain-events';

import type { WebhookEventType } from '@storageos/shared';

/**
 * Mapping de eventos de dominio internos (`domain.X`, emitidos por los
 * services via EventEmitter2) a los nombres publicos que reciben los
 * webhooks. La whitelist (`WEBHOOK_EVENT_TYPES`) vive en
 * `@storageos/shared` y se valida en los Zod schemas.
 *
 * Mantener este mapping sincronizado: si se anade un nuevo evento
 * suscribible, hay que:
 *   1. Anadirlo a `WebhookEventTypes` en shared.
 *   2. Anadir el mapping aqui.
 *   3. Anadir un listener en `WebhooksDispatcherService`.
 */
export const DOMAIN_TO_WEBHOOK_EVENT: Record<string, WebhookEventType> = {
  [DOMAIN_EVENTS.invoice_issued]: 'invoice.created',
  [DOMAIN_EVENTS.invoice_paid]: 'invoice.paid',
  [DOMAIN_EVENTS.invoice_overdue]: 'invoice.overdue',
  [DOMAIN_EVENTS.contract_signed]: 'contract.signed',
  [DOMAIN_EVENTS.lead_created]: 'lead.created',
};
