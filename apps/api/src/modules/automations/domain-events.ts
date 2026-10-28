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
  /** El inquilino anuló su baja (o aceptó una oferta para quedarse). No es trigger. */
  contract_move_out_cancelled: 'domain.contract_move_out_cancelled',
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
  /** Mensaje del chat inquilino ↔ equipo (no son disparadores de automatizaciones). */
  customer_message_from_staff: 'domain.customer_message_from_staff',
  customer_message_from_customer: 'domain.customer_message_from_customer',
  /** Un trastero pasó a `available` (fin de contrato, cambio manual…) → lo oye la lista de espera. */
  unit_available: 'domain.unit_available',
  /** Un contrato cambió de trastero → el acceso del inquilino se rehace con sus trasteros. */
  contract_unit_changed: 'domain.contract_unit_changed',
  /** Abre el local de una reserva anticipada: empieza el alquiler (acceso). */
  contract_pre_opening_started: 'domain.contract_pre_opening_started',
  /** Un local con reservas anticipadas abre (resumen al equipo). */
  facility_pre_opening_opened: 'domain.facility_pre_opening_opened',
  /** Un cobro automático (auto-charge, reintento, domiciliación) fue rechazado → aviso al inquilino. */
  payment_failed: 'domain.payment_failed',
  /** Remesa SEPA generada → preaviso de cargo a cada deudor. */
  sepa_remittance_created: 'domain.sepa_remittance_created',
  /** Reserva online (booking self-service) creada → aviso al staff. */
  booking_created: 'domain.booking_created',
  /**
   * Un cobro de una factura pagada se devolvió (contracargo, devolución SEPA o
   * N43) y vuelve a estar vencida → el escalado de impagos empieza de cero. No
   * es trigger.
   */
  invoice_payment_reverted: 'domain.invoice_payment_reverted',
} as const;

export interface InvoicePaymentRevertedPayload {
  tenantId: string;
  invoiceId: string;
}

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

/** Payload de `contract_pre_opening_started` (no es trigger de automations). */
export interface ContractPreOpeningStartedPayload {
  tenantId: string;
  contractId: string;
  customerId: string;
}

/** Payload de `facility_pre_opening_opened` (no es trigger de automations). */
export interface FacilityPreOpeningOpenedPayload {
  tenantId: string;
  facilityId: string;
  openingDay: string;
  /** Reservas firmadas que empiezan. */
  started: number;
  /** De ellas, sin la primera mensualidad pagada (no reciben acceso hasta pagarla). */
  unpaid: number;
  /** Fianzas en efectivo aún por cobrar en el local. */
  cashDepositsPending: number;
  /** Reservas sin firmar que pasan a ser un alta normal. */
  unsigned: number;
  /** Reservas cuyo trastero se cambió por otro libre al abrir. */
  reassigned: number;
  /** Reservas con el trastero fuera de servicio y sin otro igual libre. */
  unitProblems: number;
}

/** Payload de `contract_unit_changed` (no es trigger de automations). */
export interface ContractUnitChangedPayload {
  tenantId: string;
  contractId: string;
  customerId: string;
  fromUnitId: string;
  toUnitId: string;
}

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/**
 * Payload ligero para avisar al INQUILINO por push de una resolución (incidencia,
 * cambio de trastero…). No pasa por el motor de automations/plantillas; solo lo
 * consume `PushService`. Por eso no reutiliza el `DomainEventPayload` pesado.
 */
/** Baja anulada desde el portal: aviso al equipo. */
export interface MoveOutCancelledPayload {
  tenantId: string;
  contractId: string;
  contractNumber: string;
  customerName: string;
  /** `portal` = la anuló el inquilino · `retention_offer` = aceptó una oferta. */
  reason: 'portal' | 'retention_offer';
}

/** Mensaje del chat: quién, a quién y por qué canal entró. */
export interface CustomerMessagePayload {
  tenantId: string;
  customerId: string;
  messageId: string;
  body: string;
  channel: 'portal' | 'whatsapp' | 'email';
  /** Solo en mensajes del equipo: por dónde sale además (canal del inquilino). */
  replyVia?: 'whatsapp' | 'email' | null;
}

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
