import { z } from 'zod';

/**
 * Mejoras del soporte del panel del tenant: categorías fijas, filtros de la
 * lista, estado del servicio y plazos de respuesta orientativos.
 */

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------

export const SUPPORT_TICKET_CATEGORIES = [
  'billing',
  'access',
  'web',
  'contracts',
  'account',
  'bug',
  'other',
] as const;
export const SupportTicketCategoryEnum = z.enum(SUPPORT_TICKET_CATEGORIES);
export type SupportTicketCategory = z.infer<typeof SupportTicketCategoryEnum>;

export const SUPPORT_TICKET_CATEGORY_LABELS: Record<SupportTicketCategory, string> = {
  billing: 'Facturación y cobros',
  access: 'Accesos y puertas',
  web: 'Web y reservas',
  contracts: 'Contratos e inquilinos',
  account: 'Cuenta y plan',
  bug: 'Errores de la aplicación',
  other: 'Otra',
};

/** Las categorías antiguas (texto libre) se enseñan tal cual. */
export function supportCategoryLabel(category: string | null | undefined): string | null {
  if (!category) return null;
  if (category === 'custom_domain') return 'Dominio propio';
  return (SUPPORT_TICKET_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

// ---------------------------------------------------------------------------
// Lista del tenant
// ---------------------------------------------------------------------------

/** Abiertos (abierto o en curso), los que esperan su respuesta y los terminados. */
export const SupportTicketListFilterEnum = z.enum(['open', 'waiting', 'closed']);
export type SupportTicketListFilter = z.infer<typeof SupportTicketListFilterEnum>;

/** Días tras el cierre en los que el negocio aún puede reabrir el ticket. */
export const SUPPORT_TICKET_REOPEN_DAYS = 7;

/** Compañeros en copia de un ticket (como mucho). */
export const SUPPORT_TICKET_MAX_WATCHERS = 10;

export const SetTicketWatchersSchema = z.object({
  userIds: z
    .array(z.string().uuid())
    .max(
      SUPPORT_TICKET_MAX_WATCHERS,
      `Como mucho ${SUPPORT_TICKET_MAX_WATCHERS} personas en copia`,
    ),
});
export type SetTicketWatchersInput = z.infer<typeof SetTicketWatchersSchema>;

export interface SupportTicketWatcherDto {
  userId: string;
  fullName: string;
  email: string;
}

/** Compañero del negocio que se puede poner en copia. */
export interface SupportTeammateDto {
  id: string;
  fullName: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Estado del servicio
// ---------------------------------------------------------------------------

export const ServiceStatusEnum = z.enum(['ok', 'degraded', 'incident']);
export type ServiceStatusValue = z.infer<typeof ServiceStatusEnum>;

export const SERVICE_STATUS_LABELS: Record<ServiceStatusValue, string> = {
  ok: 'Todo funciona con normalidad',
  degraded: 'Funcionamiento degradado',
  incident: 'Incidencia',
};

export const UpdateServiceStatusSchema = z
  .object({
    status: ServiceStatusEnum,
    message: z
      .string()
      .trim()
      .max(500, 'El mensaje no puede pasar de 500 caracteres')
      .optional()
      .or(z.literal('')),
  })
  .refine((v) => v.status === 'ok' || (v.message ?? '').length >= 5, {
    message: 'Cuenta qué pasa (al menos 5 caracteres)',
    path: ['message'],
  });
export type UpdateServiceStatusInput = z.infer<typeof UpdateServiceStatusSchema>;

export interface ServiceStatusDto {
  status: ServiceStatusValue;
  message: string | null;
  /** Desde cuándo está en este estado. */
  since: string;
  updatedAt: string;
}

export interface ServiceIncidentDto {
  id: string;
  status: Exclude<ServiceStatusValue, 'ok'>;
  message: string | null;
  startedAt: string;
  resolvedAt: string | null;
  createdByName: string | null;
}

export interface AdminServiceStatusDto extends ServiceStatusDto {
  updatedByName: string | null;
  /** Últimas incidencias, la más reciente primero. */
  incidents: ServiceIncidentDto[];
}

// ---------------------------------------------------------------------------
// Plazos de respuesta
// ---------------------------------------------------------------------------

type Priority = 'low' | 'normal' | 'high' | 'urgent';

/** Lo que solemos tardar si aún hay pocos tickets para calcularlo. */
export const DEFAULT_SUPPORT_RESPONSE_HOURS: Record<Priority, number> = {
  urgent: 2,
  high: 8,
  normal: 24,
  low: 48,
};

/** Tickets respondidos mínimos por prioridad para fiarse de la mediana. */
export const SUPPORT_RESPONSE_MIN_SAMPLE = 5;

export interface SupportResponseTimeDto {
  /** Horas orientativas hasta la primera respuesta. */
  hours: number;
  /** Tickets respondidos en el periodo con esa prioridad. */
  sample: number;
  /** Sale de los tickets reales (si no, es el valor por defecto). */
  fromData: boolean;
}

export interface SupportResponseTimesDto {
  days: number;
  byPriority: Record<Priority, SupportResponseTimeDto>;
}

/** «Solemos responder en unas 3 horas». */
export function supportResponseTimeText(hours: number): string {
  if (hours < 1) return 'Solemos responder en menos de una hora';
  if (hours < 1.5) return 'Solemos responder en una hora más o menos';
  if (hours < 36) return `Solemos responder en unas ${Math.round(hours)} horas`;
  const days = Math.round(hours / 24);
  return `Solemos responder en unos ${days} días`;
}

/** Mediana en horas de una lista de minutos (null si está vacía). */
export function medianHours(minutes: readonly number[]): number | null {
  if (minutes.length === 0) return null;
  const sorted = [...minutes].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median =
    sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round((median / 60) * 10) / 10;
}
