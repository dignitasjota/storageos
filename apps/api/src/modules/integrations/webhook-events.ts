import { DOMAIN_EVENTS } from '../automations/domain-events';

import type { WebhookEventType, WebhookTestEvent } from '@storageos/shared';

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
  [DOMAIN_EVENTS.invoice_issued]: 'invoice.issued',
  [DOMAIN_EVENTS.invoice_paid]: 'invoice.paid',
  [DOMAIN_EVENTS.invoice_overdue]: 'invoice.overdue',
  [DOMAIN_EVENTS.contract_signed]: 'contract.signed',
  [DOMAIN_EVENTS.contract_move_out_requested]: 'contract.move_out_requested',
  [DOMAIN_EVENTS.contract_ended]: 'contract.ended',
  [DOMAIN_EVENTS.booking_created]: 'booking.created',
  [DOMAIN_EVENTS.payment_failed]: 'payment.failed',
  [DOMAIN_EVENTS.lead_created]: 'lead.created',
};

/**
 * Nombres antiguos que se siguen enviando a quien se suscribió con ellos
 * (`invoice.created` = factura emitida).
 */
export const LEGACY_WEBHOOK_ALIASES: Record<string, WebhookEventType[]> = {
  'invoice.issued': ['invoice.created'],
};

const SAMPLE_CUSTOMER = {
  firstName: 'Ana',
  lastName: 'García',
  displayName: 'Ana García',
  email: 'ana@example.com',
};
const SAMPLE_CONTRACT = {
  number: 'CT-2026-0001',
  priceMonthly: '60.00',
  startDate: '2026-01-15',
  endDate: '',
};
const SAMPLE_UNIT = { code: 'A-12' };
const SAMPLE_FACILITY = { name: 'Local de ejemplo' };
const SAMPLE_INVOICE = {
  number: 'FA/2026/00001',
  total: '72.60',
  issueDate: '2026-01-15T00:00:00.000Z',
};

/**
 * Datos de ejemplo de un evento para el envío de prueba: misma forma que el
 * aviso real, con identificadores falsos. Quien lo recibe ve `test: true`.
 */
export function sampleWebhookData(
  tenantId: string,
  event: WebhookTestEvent,
): Record<string, unknown> {
  const base = {
    tenantId,
    occurredAt: new Date().toISOString(),
  };
  const fakeId = '00000000-0000-7000-8000-000000000000';
  switch (event) {
    case 'ping':
      return { ...base, message: 'Envío de prueba de TrasterOS: tu dirección recibe los avisos.' };
    case 'invoice.issued':
    case 'invoice.paid':
    case 'invoice.overdue':
      return {
        ...base,
        entityType: 'invoice',
        entityId: fakeId,
        customerId: fakeId,
        scope: { customer: SAMPLE_CUSTOMER, invoice: SAMPLE_INVOICE },
      };
    case 'payment.failed':
      return {
        ...base,
        entityType: 'invoice',
        entityId: fakeId,
        customerId: fakeId,
        scope: {
          invoice: SAMPLE_INVOICE,
          payment: { amount: '72.60', reason: 'Fondos insuficientes' },
        },
      };
    case 'contract.signed':
    case 'contract.ended':
    case 'contract.move_out_requested':
    case 'booking.created':
      return {
        ...base,
        entityType: 'contract',
        entityId: fakeId,
        customerId: fakeId,
        scope: {
          customer: SAMPLE_CUSTOMER,
          contract: SAMPLE_CONTRACT,
          unit: SAMPLE_UNIT,
          facility: SAMPLE_FACILITY,
        },
      };
    case 'lead.created':
      return {
        ...base,
        entityType: 'lead',
        entityId: fakeId,
        leadId: fakeId,
        scope: {
          lead: {
            firstName: 'Ana',
            lastName: 'García',
            displayName: 'Ana García',
            email: 'ana@example.com',
            phone: '+34600000000',
          },
        },
      };
    default:
      return base;
  }
}
