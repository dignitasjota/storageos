/**
 * Eventos de dominio emitidos por los services al ocurrir hechos de
 * negocio. Cada evento mapea 1:1 con un trigger de `AutomationTrigger`.
 *
 * Estos nombres se usan como literal strings en `@OnEvent('domain.X')`
 * y se centralizan aqui para evitar typos.
 *
 * Convencion: `domain.<entidad>.<accion>` en snake_case dentro del nombre
 * del trigger asociado.
 */
export const DOMAIN_EVENTS = {
  customer_created: 'domain.customer_created',
  contract_signed: 'domain.contract_signed',
  contract_ending_soon: 'domain.contract_ending_soon',
  contract_ended: 'domain.contract_ended',
  /** El inquilino solicita la baja (move-out) desde el portal. */
  contract_move_out_requested: 'domain.contract_move_out_requested',
  invoice_issued: 'domain.invoice_issued',
  invoice_overdue: 'domain.invoice_overdue',
  invoice_paid: 'domain.invoice_paid',
  invoice_rectified: 'domain.invoice_rectified',
  reservation_confirmed: 'domain.reservation_confirmed',
  lead_created: 'domain.lead_created',
  incident_created: 'domain.incident_created',
  review_submitted: 'domain.review_submitted',
  /** Una incidencia del inquilino se resolvió/cerró (push al inquilino). */
  incident_resolved: 'domain.incident_resolved',
  /** El staff resolvió una solicitud de cambio de trastero (push al inquilino). */
  unit_change_resolved: 'domain.unit_change_resolved',
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/**
 * Payload ligero para avisar al INQUILINO por push de una resolución (incidencia,
 * cambio de trastero…). No pasa por el motor de automations/plantillas; solo lo
 * consume `PushService`. Por eso no reutiliza el `DomainEventPayload` pesado.
 */
export interface CustomerNotifyPayload {
  tenantId: string;
  customerId: string;
  title: string;
  body: string;
  url?: string;
}

/**
 * Payload generico de cualquier evento de dominio. Cada evento concreto
 * lleva ademas el id de la entidad principal y un snapshot con datos
 * suficientes para renderizar templates sin hacer consultas extras.
 *
 * `scope` contiene las variables ya preparadas para Handlebars (tenant,
 * customer, contract, invoice, unit, facility...).
 */
export interface DomainEventPayload {
  tenantId: string;
  entityType: 'customer' | 'contract' | 'invoice' | 'reservation' | 'lead' | 'incident' | 'review';
  entityId: string;
  /** Email/telefono del recipient si aplica (customer principal). */
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  /** Customer asociado (para vincular communications). */
  customerId?: string | null;
  /** Lead asociado (para vincular communications). */
  leadId?: string | null;
  /** Snapshot listo para Handlebars. */
  scope: Record<string, unknown>;
}
