import { z } from 'zod';

import type {
  DashboardCashDto,
  DashboardCommercialDto,
  DashboardFacilityRowDto,
  DashboardMovesDto,
  DashboardPeriodFiguresDto,
  DashboardResultDto,
  DashboardVacancyDto,
} from './overview';
import type {
  ChurnRiskKpiDto,
  CustomerStatsKpiDto,
  LeadsFunnelKpiDto,
  MonthlyRevenueKpiDto,
  OccupancyKpiDto,
  ReceivablesDto,
  RevenueForecastDto,
  RevenueKpiDto,
} from '../reports/types';

export * from './overview';

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
  /** Importe pendiente (facturas). */
  amount?: number;
  /** Factura: el inquilino tiene una tarjeta o domiciliación guardada para cobrarla ya. */
  chargeable?: boolean;
  /** Factura: ya se está cobrando («Cobro en curso», «En plan de pagos»); no se reclama. */
  note?: string | null;
  /** Para llamar o escribir desde la fila. */
  phone?: string | null;
  customerId?: string | null;
}

/** Bandeja operativa «Hoy»: lo que el equipo debe atender, de un vistazo. */
export interface TodayDto {
  /** Fecha del día en ISO (para la cabecera). */
  date: string;
  /** Asuntos de hoy: lo que vence hoy o está atrasado y se puede hacer hoy (deuda: uno por inquilino). */
  urgentCount: number;
  /** Entradas de hoy: contratos que empiezan hoy (acceso a emitir). */
  moveInsToday: { count: number; items: TodayItemDto[] };
  /** Salidas de hoy y atrasadas: contratos con la fecha de fin hoy o pasada, sin cerrar. */
  moveOutsToday: { count: number; items: TodayItemDto[] };
  /** Tareas vencidas o que vencen hoy (open/in_progress). */
  tasksDue: { count: number; items: TodayItemDto[] };
  /** Seguimientos CRM (customer_followups) vencidos o para hoy. */
  followupsDue: { count: number; items: TodayItemDto[] };
  /** Seguimientos de contactos (lead_followups) vencidos o para hoy. */
  leadFollowupsDue: { count: number; items: TodayItemDto[] };
  /** Contactos nuevos que llevan más del plazo sin atender. */
  unattendedLeads: { count: number; items: TodayItemDto[] };
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
  /** Solicitudes de protección de datos sin cerrar que vencen en 7 días (o ya vencidas). */
  rgpdRequestsDue: { count: number; items: TodayItemDto[] };
  /** Reservas pendientes que expiran en los próximos 7 días. */
  reservationsExpiring: { count: number; items: TodayItemDto[] };
  /** Facturas que vencen hoy (issued con dueDate = hoy). */
  invoicesDueToday: { count: number; totalDue: number; items: TodayItemDto[] };
  /** Facturas vencidas a reclamar. */
  invoicesOverdue: { count: number; totalPending: number; items: TodayItemDto[] };
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
  /**
   * Locales por abrir que abren en 7 días o con reservas que ya pasaron el
   * plazo máximo (el inquilino puede cancelar con devolución total).
   */
  preOpeningSoon: { count: number; items: TodayItemDto[] };
  /** Cuotas que cambian en los próximos 7 días (cambios programados y subidas). */
  priceChangesSoon?: { count: number; items: TodayItemDto[] };
  /** Productos por debajo del stock mínimo en algún local. */
  lowStock: { count: number; items: TodayItemDto[] };
  /** Trasteros en mantenimiento o bloqueados hace más de 7 días o pasada su fecha prevista. */
  unitsOutOfService: { count: number; items: TodayItemDto[] };
  /** Documentos de locales que caducan en 30 días o ya caducados. */
  facilityDocumentsExpiring: { count: number; items: TodayItemDto[] };
  /** Documentos de inquilinos con contrato vivo que caducan en 30 días o ya caducados. */
  customerDocumentsExpiring: { count: number; items: TodayItemDto[] };
  /** Vencimientos del negocio vencidos o en los próximos 7 días. */
  businessRemindersDue: { count: number; items: TodayItemDto[] };
  /** Gastos pendientes de pagar que vencen esta semana o ya vencieron (`id` = el gasto). */
  expensesToPay: { count: number; items: TodayItemDto[] };
}

/** Un paso de la puesta en marcha del operador. */
export interface OnboardingStepDto {
  key: string;
  label: string;
  /** Qué es y por qué importa, en una línea. */
  hint: string;
  done: boolean;
  /** `required` = sin esto no se puede operar; `recommended` = mejora la experiencia. */
  group: 'required' | 'recommended';
  /** Ruta a la que ir para completar el paso. */
  href: string;
  /** Atajo alternativo (p. ej. importar desde un Excel). */
  secondary?: { label: string; href: string };
  /** El tenant puede darlo por resuelto («no aplica»). */
  skippable: boolean;
  /** Dado por resuelto a mano (cuenta como hecho). */
  skipped: boolean;
  /** Texto del botón para darlo por resuelto. */
  skipLabel?: string;
}

/** Pasos que el tenant puede dar por resueltos aunque no se deduzcan de sus datos. */
export const ONBOARDING_SKIPPABLE_STEPS = [
  'monthly_billing',
  'customer',
  'contract',
  'branding',
  'contract_template',
  'team',
  'verifactu',
  'test_run',
] as const;
export type OnboardingSkippableStep = (typeof ONBOARDING_SKIPPABLE_STEPS)[number];

export const SkipOnboardingStepSchema = z.object({ skipped: z.boolean() });

/** De dónde parte el negocio: decide qué pasos se le piden. */
export const OnboardingPathEnum = z.enum(['new', 'opening', 'migrating']);
export type OnboardingPath = z.infer<typeof OnboardingPathEnum>;

export const UpdateOnboardingStateSchema = z.object({
  path: OnboardingPathEnum.optional(),
  wizard: z.enum(['done', 'skipped']).optional(),
});
export type UpdateOnboardingStateInput = z.infer<typeof UpdateOnboardingStateSchema>;

/** Inquilino de prueba: el propio tenant recorre lo que vivirán sus clientes. */
export interface OnboardingTestRunDto {
  customerId: string;
  contractId: string;
  /** Null si el contrato ya se firmó. */
  signingUrl: string | null;
}

/** Siguiente cosa que conviene aprender cuando ya está en marcha. */
export interface OnboardingNextStepDto {
  key: string;
  /** `week` primera semana, `month` primer mes, `later` más adelante. */
  stage: 'week' | 'month' | 'later';
  title: string;
  text: string;
  href: string;
  cta: string;
  /** Guía de «Cómo funciona» (`/help#tema`). */
  guide: string;
}

/** Checklist de puesta en marcha del operador. */
export interface OnboardingDto {
  /** Si la web ya se ve y acepta reservas, y qué le falta para ello. */
  web: { url: string; published: boolean; bookable: boolean; missing: string[] };
  path: OnboardingPath | null;
  /** Cuenta recién creada que aún no ha pasado por el asistente. */
  wizardPending: boolean;
  /** Inquilino de prueba en curso. */
  testRun: OnboardingTestRunDto | null;
  steps: OnboardingStepDto[];
  /** Pasos imprescindibles completados / total (0-1). */
  progress: number;
  /** Todos los imprescindibles hechos (la tarjeta del Resumen se oculta). */
  completed: boolean;
  requiredDone: number;
  requiredTotal: number;
  recommendedDone: number;
  recommendedTotal: number;
}

/** Cifras del mes en curso para la cabecera de «Hoy». */
export interface TodayKpisDto {
  /** Quien no puede ver facturas ni cobros recibe el dinero a cero. */
  moneyVisible: boolean;
  /** Facturado en el mes, neto de abonos y sustituciones. */
  invoicedMonth: number;
  /** Cobrado en el mes (cobros reales, sin fianzas y neto de devoluciones). */
  collectedMonth: number;
  /** Deuda vencida pendiente. */
  overduePending: number;
  occupancyPct: number;
  freeUnits: number;
  totalUnits: number;
  /** Altas y bajas del mes, con el criterio de Analítica → Bajas. */
  moveInsMonth: number;
  moveOutsMonth: number;
  /** Inquilinos con deuda vencida que nunca han entrado en su área de clientes. */
  debtorsWithoutPortal: number;
  /** Lo mismo del mes anterior hasta el mismo día, para comparar. */
  previous: {
    invoicedMonth: number;
    collectedMonth: number;
    moveInsMonth: number;
    moveOutsMonth: number;
  };
  /** Ocupación objetivo del negocio (estrategia de precios) y trasteros que faltan. */
  targetOccupancyPct: number;
  unitsToTarget: number;
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

/**
 * Cifras del Resumen en una sola respuesta. Una sección que no se pudo calcular
 * llega a null, y la pantalla lo dice en vez de enseñarla vacía.
 */
export interface DashboardOverviewDto {
  month: TodayKpisDto | null;
  period: DashboardPeriodFiguresDto | null;
  cash: DashboardCashDto | null;
  vacancy: DashboardVacancyDto | null;
  moves: DashboardMovesDto | null;
  byFacility: DashboardFacilityRowDto[] | null;
  /** Null también si el usuario no puede ver los gastos. */
  result: DashboardResultDto | null;
  commercial: DashboardCommercialDto | null;
  revenue: RevenueKpiDto | null;
  occupancy: OccupancyKpiDto | null;
  customers: CustomerStatsKpiDto | null;
  receivables: ReceivablesDto | null;
  monthlyRevenue: MonthlyRevenueKpiDto | null;
  forecast: RevenueForecastDto | null;
  churnRisk: ChurnRiskKpiDto | null;
  leads: LeadsFunnelKpiDto | null;
}

// --- Apartar avisos -----------------------------------------------------------

export const TenantTodaySnoozeKindEnum = z.enum([
  'task',
  'customer_followup',
  'lead_followup',
  'lead',
  'invoice',
  'deposit',
  'customer_debt',
  'unit_request',
  'waitlist',
  'draft',
  'reservation',
  'payment',
  'plan',
  'inventory',
  'chat',
  /** Una caja sin cerrar (refId = el local, o el negocio si es la caja global). */
  'cash',
  /** Un aviso de un expediente de impago. */
  'collections_case',
]);
export type TenantTodaySnoozeKind = z.infer<typeof TenantTodaySnoozeKindEnum>;

export const CreateTenantTodaySnoozeSchema = z.object({
  kind: TenantTodaySnoozeKindEnum,
  refId: z.string().uuid(),
  days: z.number().int().min(1).max(30),
  label: z.string().trim().max(200).optional(),
});
export type CreateTenantTodaySnoozeInput = z.infer<typeof CreateTenantTodaySnoozeSchema>;

export interface TenantTodaySnoozeDto {
  id: string;
  kind: TenantTodaySnoozeKind;
  refId: string;
  label: string | null;
  until: string;
}

// --- Lo que completa «Hoy» ----------------------------------------------------

/** Un aviso con su enlace; `kind` y `refId` sirven para apartarlo. */
export interface TodayAttentionItemDto {
  kind: TenantTodaySnoozeKind;
  refId: string;
  label: string;
  detail: string | null;
  date: string | null;
  href: string;
  phone?: string | null;
}

export interface TodayAttentionSectionDto {
  count: number;
  items: TodayAttentionItemDto[];
}

/** Un inquilino con deuda: la vista por persona, no por factura. */
export interface TodayDebtDto {
  customerId: string;
  customerName: string;
  phone: string | null;
  amount: number;
  days: number;
  invoiceCount: number;
  invoiceIds: string[];
  chargeable: boolean;
  /** Va en un plan de pagos o en la remesa: no hay que reclamar. */
  note: string | null;
  nextStep: { label: string; date: string } | null;
  lastContactAt: string | null;
}

export interface TodayTomorrowItemDto {
  id: string;
  kind: 'in' | 'out';
  label: string;
  detail: string | null;
  phone: string | null;
  /** Lo que falta para que salga bien: «Firma», «Primer pago», «Acceso»… */
  missing: string[];
}

export interface TodayWeekItemDto {
  id: string;
  kind: 'task' | 'followup' | 'lead_followup' | 'move_in' | 'move_out' | 'reminder';
  label: string;
  detail: string | null;
  date: string;
  href: string;
}

export interface TodayDoneDto {
  tasks: number;
  followups: number;
  contractsSigned: number;
  leadsContacted: number;
  /** Cobrado hoy por forma de pago; vacío sin permiso sobre los cobros. */
  payments: { method: string; label: string; amount: number; count: number }[];
  collected: number;
  /** Ya se ha hecho el cierre de caja de hoy. */
  cashClosed: boolean;
}

export interface TodayExtrasDto {
  /** Asuntos de estos apartados que se suman a los de hoy. */
  urgentCount: number;
  unitRequests: TodayAttentionSectionDto;
  waitlistMatches: TodayAttentionSectionDto;
  draftsAttention: TodayAttentionSectionDto;
  reservationsConfirmed: TodayAttentionSectionDto;
  paymentProblems: TodayAttentionSectionDto;
  plansLate: TodayAttentionSectionDto;
  inventoryIssues: TodayAttentionSectionDto;
  chatsWaiting: TodayAttentionSectionDto;
  /** Cajas de días anteriores con movimientos en efectivo y sin cerrar. */
  cashUnclosed: TodayAttentionSectionDto;
  /** Expedientes de impago que piden algo (plazo, candado, cita, sobrante…). */
  collectionsAlerts: TodayAttentionSectionDto;
  debts: { count: number; totalAmount: number; rows: TodayDebtDto[] };
  tomorrow: TodayTomorrowItemDto[];
  week: TodayWeekItemDto[];
  done: TodayDoneDto;
  snoozed: TenantTodaySnoozeDto[];
}

/** Código de acceso de un inquilino para el mostrador. */
export interface TodayDeskAccessDto {
  credentials: { id: string; method: 'pin' | 'qr'; label: string | null; value: string | null }[];
}

// --- Resumen del día a medida --------------------------------------------------

export const DEFAULT_DAILY_SUMMARY_HOUR = 8;

export const DailySummaryPrefsSchema = z.object({
  hour: z.number().int().min(5).max(20).default(DEFAULT_DAILY_SUMMARY_HOUR),
  /** Locales del resumen; vacío = todos los que ve la persona. */
  facilityIds: z.array(z.string().uuid()).max(100).default([]),
  /** Además del correo (o sin él), un aviso en el móvil. */
  push: z.boolean().default(false),
});
export type DailySummaryPrefs = z.infer<typeof DailySummaryPrefsSchema>;

export function parseDailySummaryPrefs(value: unknown): DailySummaryPrefs {
  const parsed = DailySummaryPrefsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DailySummaryPrefsSchema.parse({});
}
