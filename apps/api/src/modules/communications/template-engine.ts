import Handlebars from 'handlebars';

import type { AutomationTriggerValue } from '@storageos/shared';

/**
 * Whitelist de variables permitidas por trigger. Cuando una plantilla se
 * renderiza, las variables que no esten en la whitelist se ignoran (se
 * sustituyen por cadena vacia) para evitar filtrar datos sensibles
 * accidentalmente.
 *
 * El motor compila las plantillas con `noEscape: false` y `strict: true`
 * para que un `{{var}}` faltante lance error en desarrollo y aparezca
 * vacio en produccion (segun env).
 */
export const TEMPLATE_VARIABLES_BY_TRIGGER: Record<
  AutomationTriggerValue | 'manual',
  readonly string[]
> = {
  customer_created: [
    'customer.firstName',
    'customer.lastName',
    'customer.displayName',
    'customer.email',
    'customer.phone',
    'tenant.name',
    'tenant.contactEmail',
  ],
  contract_signed: [
    'customer.firstName',
    'customer.displayName',
    'contract.number',
    'contract.priceMonthly',
    'contract.startDate',
    'contract.endDate',
    'unit.code',
    'facility.name',
    'tenant.name',
  ],
  contract_ending_soon: [
    'customer.firstName',
    'customer.displayName',
    'contract.number',
    'contract.endDate',
    'unit.code',
    'tenant.name',
  ],
  contract_ended: [
    'customer.firstName',
    'customer.displayName',
    'contract.number',
    'contract.endDate',
    'unit.code',
    'tenant.name',
  ],
  invoice_issued: [
    'customer.firstName',
    'customer.displayName',
    'invoice.number',
    'invoice.total',
    'invoice.dueDate',
    'invoice.pdfUrl',
    'tenant.name',
  ],
  invoice_overdue: [
    'customer.firstName',
    'customer.displayName',
    'invoice.number',
    'invoice.total',
    'invoice.amountPending',
    'invoice.dueDate',
    'invoice.daysOverdue',
    'tenant.name',
  ],
  invoice_paid: [
    'customer.firstName',
    'customer.displayName',
    'invoice.number',
    'invoice.total',
    'invoice.paidAt',
    'tenant.name',
  ],
  reservation_confirmed: [
    'customer.firstName',
    'customer.displayName',
    'reservation.validFrom',
    'reservation.validUntil',
    'unit.code',
    'facility.name',
    'tenant.name',
  ],
  lead_created: [
    'lead.firstName',
    'lead.lastName',
    'lead.displayName',
    'lead.email',
    'lead.phone',
    'tenant.name',
  ],
  manual: [
    'customer.firstName',
    'customer.lastName',
    'customer.displayName',
    'lead.firstName',
    'lead.displayName',
    'tenant.name',
  ],
};

/**
 * Renderiza una plantilla. Si `allowedKeys` se proporciona, el resto de
 * variables del scope se eliminan (defensa contra filtrado accidental).
 */
export function renderTemplate(
  template: string,
  scope: Record<string, unknown>,
  allowedKeys?: readonly string[],
): string {
  if (!template) return '';
  const compile = Handlebars.compile(template, { noEscape: false, strict: false });
  const safeScope = allowedKeys ? pickAllowed(scope, allowedKeys) : scope;
  return compile(safeScope);
}

function pickAllowed(
  scope: Record<string, unknown>,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of allowedKeys) {
    const segments = path.split('.');
    let src: unknown = scope;
    let dst = out;
    for (let i = 0; i < segments.length; i++) {
      const key = segments[i]!;
      if (typeof src !== 'object' || src === null) {
        src = undefined;
        break;
      }
      src = (src as Record<string, unknown>)[key];
      if (i === segments.length - 1) {
        dst[key] = src ?? '';
      } else {
        if (typeof dst[key] !== 'object' || dst[key] === null) dst[key] = {};
        dst = dst[key] as Record<string, unknown>;
      }
    }
  }
  return out;
}
