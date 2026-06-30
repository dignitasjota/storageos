/** Tipo de evento del calendario operativo. */
export type CalendarEventType = 'task' | 'maintenance' | 'contract_ending' | 'reservation_expiring';

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
