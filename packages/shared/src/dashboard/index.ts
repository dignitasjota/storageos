/** Un ítem resumido para la bandeja «Hoy» (lo que requiere atención). */
export interface TodayItemDto {
  id: string;
  /** Título/etiqueta principal (p. ej. nombre del cliente o título de la tarea). */
  label: string;
  /** Texto secundario (p. ej. trastero·local, prioridad, importe). */
  detail: string | null;
  /** Fecha relevante en ISO (vencimiento, fin de contrato…); null si no aplica. */
  date: string | null;
}

/** Bandeja operativa «Hoy»: lo que el equipo debe atender, de un vistazo. */
export interface TodayDto {
  /** Tareas vencidas o que vencen hoy (open/in_progress). */
  tasksDue: { count: number; items: TodayItemDto[] };
  /** Contratos que vencen en los próximos 30 días (active/ending). */
  contractsEndingSoon: { count: number; items: TodayItemDto[] };
  /** Reservas pendientes que expiran en los próximos 7 días. */
  reservationsExpiring: { count: number; items: TodayItemDto[] };
  /** Facturas vencidas a reclamar. */
  invoicesOverdue: { count: number; totalPending: number };
  /** Incidencias abiertas (reportadas + en investigación). */
  incidentsOpen: number;
  /** Solicitudes de cambio de trastero pendientes. */
  unitChangesPending: number;
  /** Mensajes de inquilinos sin leer. */
  unreadMessages: number;
}
