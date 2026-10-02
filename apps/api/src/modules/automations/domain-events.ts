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
  /** Factura anulada (solo la oye la copia contable de Holded; no es trigger). */
  invoice_cancelled: 'domain.invoice_cancelled',
  /**
   * Se devolvió dinero de una factura (desde la app o desde la pasarela):
   * genera la rectificativa de abono por lo devuelto. No es trigger.
   */
  invoice_refunded: 'domain.invoice_refunded',
  /** Cobro por pasarela confirmado sobre una factura ya pagada por otra vía. No es trigger. */
  payment_overpaid: 'domain.payment_overpaid',
  invoice_rectified: 'domain.invoice_rectified',
  reservation_confirmed: 'domain.reservation_confirmed',
  lead_created: 'domain.lead_created',
  incident_created: 'domain.incident_created',
  review_submitted: 'domain.review_submitted',
  /** Una incidencia del inquilino se resolvió/cerró (push al inquilino). */
  incident_resolved: 'domain.incident_resolved',
  /** El staff resolvió una solicitud de cambio de trastero (push al inquilino). */
  unit_change_resolved: 'domain.unit_change_resolved',
  /** Un trastero pasó a `available` (fin de contrato, cambio manual…) → lo oye la lista de espera. */
  unit_available: 'domain.unit_available',
  /** Un cobro automático (auto-charge, reintento, domiciliación) fue rechazado → aviso al inquilino. */
  payment_failed: 'domain.payment_failed',
  /** Remesa SEPA generada → preaviso de cargo a cada deudor. */
  sepa_remittance_created: 'domain.sepa_remittance_created',
  /** Reserva online (booking self-service) creada → aviso al staff. */
  booking_created: 'domain.booking_created',
} as const;

export interface InvoiceCancelledPayload {
  tenantId: string;
  invoiceId: string;
}

export interface PaymentOverpaidPayload {
  tenantId: string;
  invoiceId: string;
  /** Importe cobrado de más (a devolver), en euros. */
  excess: number;
  gatewayPaymentId: string;
}

export interface InvoiceRefundedPayload {
  tenantId: string;
  invoiceId: string;
  /** Importe devuelto en esta operación (no el acumulado), en euros. */
  amount: number;
}

export interface SepaRemittanceCreatedPayload {
  tenantId: string;
  remittanceId: string;
}

export interface BookingCreatedPayload {
  tenantId: string;
  contractId: string;
  customerId: string;
}

/** Payload de `payment_failed` (no es trigger de automations). */
export interface PaymentFailedPayload {
  tenantId: string;
  invoiceId: string;
  customerId: string | null;
  amount: number;
  reason: string | null;
}

/** Payload de `unit_available`: solo lo consume `WaitlistService` (no es trigger de automations). */
export interface UnitAvailablePayload {
  tenantId: string;
  unitId: string;
}

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
