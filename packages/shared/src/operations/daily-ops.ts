import { z } from 'zod';

import { calendarDate } from '../common/calendar-date';

/**
 * Mejoras de Operaciones diarias: fotos y documentos, tipos de incidencia con
 * plazo de respuesta, coste, parte al seguro, informe, vista de pendientes y
 * previsión de los vencimientos.
 */

// ============================================================================
// Fotos y documentos (tareas, incidencias, vencimientos)
// ============================================================================

export const OPS_FILE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type OpsFileMimeType = (typeof OPS_FILE_MIME_TYPES)[number];
/** Máximo de ficheros por tarea, incidencia o vencimiento. */
export const OPS_FILES_MAX = 10;

export const OpsFileUploadSchema = z.object({
  mimeType: z.enum(OPS_FILE_MIME_TYPES),
});
export type OpsFileUploadInput = z.infer<typeof OpsFileUploadSchema>;

/** Un fichero ya subido con la URL firmada. */
export const AddOpsFileSchema = z.object({
  key: z.string().min(1).max(300),
  mimeType: z.enum(OPS_FILE_MIME_TYPES),
  filename: z.string().trim().min(1).max(200),
});
export type AddOpsFileInput = z.infer<typeof AddOpsFileSchema>;

export interface OpsFileDto {
  id: string;
  filename: string;
  mimeType: string;
  /** URL firmada (unos minutos). Vacía en las listas. */
  url: string;
  createdAt: string;
}

// ============================================================================
// Tareas: vista de pendientes y contador
// ============================================================================

/** `overdue` atrasadas · `today` vencen hoy · `week` los 7 próximos días · `none` sin fecha. */
export const TaskDueFilterEnum = z.enum(['overdue', 'today', 'week', 'none']);
export type TaskDueFilter = z.infer<typeof TaskDueFilterEnum>;

export interface MyTasksCountDto {
  /** Mías, abiertas o en curso, atrasadas o para hoy. */
  pending: number;
}

// ============================================================================
// Gasto apuntado desde una tarea o una incidencia
// ============================================================================

export const OpsExpenseSchema = z.object({
  amount: z.number().positive().finite().max(10_000_000),
  supplierId: z.string().uuid().nullish(),
  vendor: z.string().trim().max(200).optional(),
  expenseDate: calendarDate.optional(),
});
export type OpsExpenseInput = z.infer<typeof OpsExpenseSchema>;

// ============================================================================
// Incidencias
// ============================================================================

export const IncidentCategoryEnum = z.enum([
  'damage',
  'water',
  'lock',
  'access',
  'cleaning',
  'pests',
  'security',
  'complaint',
  'other',
]);
export type IncidentCategory = z.infer<typeof IncidentCategoryEnum>;

export const INCIDENT_CATEGORY_LABELS: Record<IncidentCategory, string> = {
  damage: 'Daños',
  water: 'Agua o humedad',
  lock: 'Cerradura o puerta',
  access: 'Acceso o código',
  cleaning: 'Limpieza',
  pests: 'Plagas',
  security: 'Seguridad o robo',
  complaint: 'Queja',
  other: 'Otro',
};

/** Las que el inquilino puede elegir al reportar desde el área de clientes. */
export const PORTAL_INCIDENT_CATEGORIES: IncidentCategory[] = [
  'damage',
  'water',
  'lock',
  'access',
  'cleaning',
  'pests',
  'other',
];

export const InsuranceClaimStatusEnum = z.enum(['filed', 'accepted', 'rejected', 'paid']);
export type InsuranceClaimStatus = z.infer<typeof InsuranceClaimStatusEnum>;

export const INSURANCE_CLAIM_STATUS_LABELS: Record<InsuranceClaimStatus, string> = {
  filed: 'Parte enviado',
  accepted: 'Aceptado',
  rejected: 'Rechazado',
  paid: 'Cobrado',
};

/** Horas para dar la primera respuesta según la gravedad. */
export const IncidentResponseHoursSchema = z.object({
  critical: z.number().int().min(1).max(720),
  high: z.number().int().min(1).max(720),
  medium: z.number().int().min(1).max(720),
  low: z.number().int().min(1).max(720),
});
export type IncidentResponseHours = z.infer<typeof IncidentResponseHoursSchema>;

export const DEFAULT_INCIDENT_RESPONSE_HOURS: IncidentResponseHours = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168,
};

/** Lo guardado, completado con los valores por defecto. */
export function parseIncidentResponseHours(raw: unknown): IncidentResponseHours {
  const parsed = IncidentResponseHoursSchema.partial().safeParse(raw ?? {});
  const got = parsed.success ? parsed.data : {};
  return {
    critical: got.critical ?? DEFAULT_INCIDENT_RESPONSE_HOURS.critical,
    high: got.high ?? DEFAULT_INCIDENT_RESPONSE_HOURS.high,
    medium: got.medium ?? DEFAULT_INCIDENT_RESPONSE_HOURS.medium,
    low: got.low ?? DEFAULT_INCIDENT_RESPONSE_HOURS.low,
  };
}

export const ReplyIncidentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});
export type ReplyIncidentInput = z.infer<typeof ReplyIncidentSchema>;

/** Tarea de reparación desde una incidencia (o un vencimiento). */
export const OpsTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  assignedToUserId: z.string().uuid().optional(),
  dueDate: calendarDate.optional(),
});
export type OpsTaskInput = z.infer<typeof OpsTaskSchema>;

export interface IncidentRepairTaskDto {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  assignedToName: string | null;
}

export interface IncidentReportRowDto {
  key: string;
  label: string;
  count: number;
  open: number;
}

export interface IncidentReportDto {
  from: string;
  to: string;
  total: number;
  open: number;
  resolved: number;
  /** Media de horas desde que se reporta hasta que se resuelve (null sin resueltas). */
  avgResolutionHours: number | null;
  /** % con la primera respuesta dentro de plazo (null si ninguna tenía plazo). */
  withinResponsePct: number | null;
  totalCost: number;
  insuranceClaims: number;
  byCategory: IncidentReportRowDto[];
  bySeverity: IncidentReportRowDto[];
  byFacility: IncidentReportRowDto[];
}

// ============================================================================
// Vencimientos: previsión y contador
// ============================================================================

export interface ReminderForecastItemDto {
  id: string;
  title: string;
  category: string;
  dueDate: string;
  amount: number | null;
}

export interface ReminderForecastMonthDto {
  /** YYYY-MM */
  month: string;
  items: ReminderForecastItemDto[];
  total: number;
}

export interface ReminderForecastDto {
  months: ReminderForecastMonthDto[];
  total: number;
}

export interface RemindersDueCountDto {
  /** Vencidos o que vencen en los próximos 7 días. */
  due: number;
}
