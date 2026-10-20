/** Un ítem resumido para la bandeja «Hoy» (lo que requiere atención). */
export interface TodayItemDto {
  id: string;
  /** Título/etiqueta principal (p. ej. nombre del cliente o título de la tarea). */
  label: string;
  /** Texto secundario (p. ej. trastero·local, prioridad, importe). */
  detail: string | null;
  /** Fecha relevante en ISO (vencimiento, fin de contrato…); null si no aplica. */
  date: string | null;
  /** Marca que el ítem está atrasado (fecha < hoy), para pintarlo en rojo. */
  overdue?: boolean;
  /** Id secundario para enlazar al recurso exacto (p. ej. customerId de un mensaje/seguimiento). */
  linkId?: string | null;
}

/** Bandeja operativa «Hoy»: lo que el equipo debe atender, de un vistazo. */
export interface TodayDto {
  /** Fecha del día en ISO (para la cabecera). */
  date: string;
  /** Nº de cosas urgentes hoy (atrasadas / que vencen hoy). */
  urgentCount: number;
  /** Entradas de hoy: contratos que empiezan hoy (acceso a emitir). */
  moveInsToday: { count: number; items: TodayItemDto[] };
  /** Salidas de hoy: contratos que terminan hoy (check-out + fianza). */
  moveOutsToday: { count: number; items: TodayItemDto[] };
  /** Tareas vencidas o que vencen hoy (open/in_progress). */
  tasksDue: { count: number; items: TodayItemDto[] };
  /** Seguimientos CRM (customer_followups) vencidos o para hoy. */
  followupsDue: { count: number; items: TodayItemDto[] };
  /** Leads nuevos sin contactar. */
  newLeads: { count: number; items: TodayItemDto[] };
  /** Contratos con firma solicitada aún sin firmar (token vigente). */
  signaturesPending: { count: number; items: TodayItemDto[] };
  /** Contratos que vencen en los próximos 30 días (active/ending). */
  contractsEndingSoon: { count: number; items: TodayItemDto[] };
  /** Expedientes de impago con el plazo del requerimiento vencido (a resolver). */
  collectionsDeadlines: { count: number; items: TodayItemDto[] };
  /** Fianzas retenidas sin liquidar de contratos ya finalizados/cancelados (a devolver/retener). */
  depositsToSettle: { count: number; items: TodayItemDto[] };
  /** Fianzas a cobrar en el local (justificante sin pagar fuera del pago online). */
  depositsToCollect: { count: number; items: TodayItemDto[] };
  /** Viviendas: fianzas aún sin depositar en el organismo autonómico. */
  depositsToRegister: { count: number; items: TodayItemDto[] };
  /** Reservas pendientes que expiran en los próximos 7 días. */
  reservationsExpiring: { count: number; items: TodayItemDto[] };
  /** Facturas que vencen hoy (issued con dueDate = hoy). */
  invoicesDueToday: { count: number; totalDue: number };
  /** Facturas vencidas a reclamar. */
  invoicesOverdue: { count: number; totalPending: number };
  /** Incidencias abiertas (reportadas + en investigación). */
  incidentsOpen: number;
  /** Solicitudes de cambio de trastero pendientes. */
  unitChangesPending: number;
  /** Mensajes de inquilinos sin leer. */
  unreadMessages: number;
  /** Canales de marketing activos que renuevan (suscripción/anuncio) en ≤7 días. */
  marketingRenewalsDue: { count: number; items: TodayItemDto[] };
  /** Ofertas de retención (contraoferta de baja) pendientes de respuesta del inquilino. */
  retentionOffersPending: { count: number; items: TodayItemDto[] };
}

/** Un paso del onboarding del operador (primeros pasos guiados). */
export interface OnboardingStepDto {
  key: string;
  label: string;
  done: boolean;
  /** Ruta a la que ir para completar el paso. */
  href: string;
}

/** Checklist de puesta en marcha del operador. */
export interface OnboardingDto {
  steps: OnboardingStepDto[];
  /** Pasos completados / total (0-1). */
  progress: number;
  completed: boolean;
}

/** Cifras del mes en curso para la cabecera de «Hoy». */
export interface TodayKpisDto {
  /** Facturado en el mes (emitido, sin borradores ni anuladas). */
  invoicedMonth: number;
  /** Cobrado en el mes (cobros reales). */
  collectedMonth: number;
  /** Deuda vencida pendiente. */
  overduePending: number;
  occupancyPct: number;
  freeUnits: number;
  totalUnits: number;
  /** Altas (contratos firmados) y bajas (contratos terminados) del mes. */
  moveInsMonth: number;
  moveOutsMonth: number;
  /** Inquilinos con deuda vencida que nunca han entrado en su área de clientes. */
  debtorsWithoutPortal: number;
}

export type TodayActivityKind =
  | 'contract_signed'
  | 'payment_received'
  | 'payment_failed'
  | 'move_out_requested'
  | 'lead_created'
  | 'customer_message'
  | 'incident_reported';

export interface TodayActivityDto {
  at: string;
  kind: TodayActivityKind;
  label: string;
  detail: string | null;
  href: string;
}

/** `GET /dashboard/today/summary`. */
export interface TodaySummaryDto {
  kpis: TodayKpisDto;
  /** Lo que ha pasado en las últimas 48 h, lo más reciente primero. */
  activity: TodayActivityDto[];
}
