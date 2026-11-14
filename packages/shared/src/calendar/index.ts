/** Tipo de evento del calendario operativo. */
export type CalendarEventType =
  | 'task'
  | 'maintenance'
  | 'contract_starting'
  | 'contract_ending'
  /** Contrato con renovación automática que llega a su fecha: se prorroga solo. */
  | 'contract_renewing'
  | 'reservation_expiring'
  | 'business_reminder'
  | 'price_change'
  /** Factura emitida sin cobrar que vence ese día. */
  | 'invoice_due'
  /** Documento de un local (licencia, seguro, contrato…) que caduca. */
  | 'document_expiring';

/** Un evento del calendario operativo (vencimiento, tarea, mantenimiento…). */
export interface CalendarEventDto {
  id: string;
  type: CalendarEventType;
  /** Fecha del evento (ISO). */
  date: string;
  label: string;
  detail: string | null;
  /** Ruta del panel a la que navegar. */
  href: string;
}

export interface CalendarEventsDto {
  events: CalendarEventDto[];
}
