import { z } from 'zod';

import {
  PlatformLeadManualLostReasonEnum,
  PlatformLeadManualStageEnum,
  PlatformLeadStageEnum,
} from '../admin/leads';
import { parseLeadCount } from '../admin/leads-insights';

import type { SalesLeadDto } from './index';

/**
 * Cartera del comercial: la lista de prospectos por páginas (con orden y
 * filtros), la cola «Por hacer», las acciones en lote y los filtros de sus
 * clientes.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

// ------------------------------------------------------------------ lista

export const SALES_LEAD_SORTS = [
  'priority',
  'value',
  'last_contact',
  'assigned',
  'updated',
] as const;
export const SalesLeadSortEnum = z.enum(SALES_LEAD_SORTS);
export type SalesLeadSort = z.infer<typeof SalesLeadSortEnum>;
export const SALES_LEAD_SORT_LABELS: Record<SalesLeadSort, string> = {
  priority: 'Prioridad',
  value: 'Cuota prevista',
  last_contact: 'Último contacto',
  assigned: 'Asignado el',
  updated: 'Último cambio',
};
/** Dirección por defecto de cada orden (lo más útil primero). */
export const SALES_LEAD_SORT_DEFAULT_DIR: Record<SalesLeadSort, 'asc' | 'desc'> = {
  priority: 'desc',
  value: 'desc',
  // Los que llevan más tiempo sin hablar, primero.
  last_contact: 'asc',
  assigned: 'desc',
  updated: 'desc',
};

/** Tamaño del negocio por sus trasteros (lo que escribió, como número). */
export const SALES_LEAD_SIZES = ['small', 'medium', 'large', 'unknown'] as const;
export const SalesLeadSizeEnum = z.enum(SALES_LEAD_SIZES);
export type SalesLeadSize = z.infer<typeof SalesLeadSizeEnum>;
export const SALES_LEAD_SIZE_LABELS: Record<SalesLeadSize, string> = {
  small: 'Menos de 50 trasteros',
  medium: 'De 50 a 149 trasteros',
  large: '150 trasteros o más',
  unknown: 'Sin dato de trasteros',
};

export function salesLeadSize(units: string | null | undefined): SalesLeadSize {
  const n = parseLeadCount(units);
  if (n === null) return 'unknown';
  if (n >= 150) return 'large';
  if (n >= 50) return 'medium';
  return 'small';
}

/** Filtros de un vistazo de la lista. */
export const SALES_LEAD_FILTERS = [
  'new_for_you',
  'untouched',
  'no_contact',
  'trial_ending',
  'pending',
] as const;
export const SalesLeadFilterEnum = z.enum(SALES_LEAD_FILTERS);
export type SalesLeadFilter = z.infer<typeof SalesLeadFilterEnum>;
export const SALES_LEAD_FILTER_LABELS: Record<SalesLeadFilter, string> = {
  new_for_you: 'Nuevos para ti',
  untouched: 'Sin tocar',
  no_contact: 'Sin contacto hace tiempo',
  trial_ending: 'Prueba que acaba',
  pending: 'Pendientes de asignar',
};

/** Temperatura de la ficha o «sin marcar». */
export const SalesLeadTemperatureFilterEnum = z.enum(['cold', 'warm', 'hot', 'none']);
export type SalesLeadTemperatureFilter = z.infer<typeof SalesLeadTemperatureFilterEnum>;

const optionalQueryText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const SalesLeadsQuerySchema = z.object({
  search: optionalQueryText(120),
  status: PlatformLeadStageEnum.optional(),
  filter: SalesLeadFilterEnum.optional(),
  batch: optionalQueryText(120),
  city: optionalQueryText(80),
  size: SalesLeadSizeEnum.optional(),
  temperature: SalesLeadTemperatureFilterEnum.optional(),
  sort: SalesLeadSortEnum.optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  cursor: optionalQueryText(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type SalesLeadsQuery = z.infer<typeof SalesLeadsQuerySchema>;

// --------------------------------------------------------------- «Por hacer»

export const SALES_QUEUE_REASONS = [
  'followup_overdue',
  'followup_today',
  'new_untouched',
  'hot_no_contact',
  'trial_ending',
] as const;
export type SalesQueueReason = (typeof SALES_QUEUE_REASONS)[number];
export const SALES_QUEUE_REASON_LABELS: Record<SalesQueueReason, string> = {
  followup_overdue: 'Seguimiento atrasado',
  followup_today: 'Seguimiento de hoy',
  new_untouched: 'Nuevo sin tocar',
  hot_no_contact: 'Caliente sin contacto reciente',
  trial_ending: 'Prueba que acaba',
};
/** Días sin hablar con un caliente para que vuelva a la cola. */
export const SALES_HOT_NO_CONTACT_DAYS = 7;
/** Días que le quedan a una prueba para que salga en la cola. */
export const SALES_TRIAL_ENDING_DAYS = 7;

export interface SalesQueueItemDto {
  lead: SalesLeadDto;
  reason: SalesQueueReason;
  /** Por qué está aquí, en una frase («Seguimiento atrasado: Volver a llamar»). */
  detail: string;
  /** Fecha que lo pone en la cola (seguimiento o fin de la prueba). */
  date: string | null;
  followupId: string | null;
}

export interface SalesQueueDto {
  items: SalesQueueItemDto[];
  /** Cuántos hay de cada motivo (aunque la cola no los traiga todos). */
  counts: Record<SalesQueueReason, number>;
  /** Hay más de los que trae la cola. */
  truncated: boolean;
}

// ----------------------------------------------------------- acciones en lote

export const SalesBulkLeadActionSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(200),
  action: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('followup'),
      title: z.string().trim().min(2).max(200),
      dueDate: isoDate,
      note: z.string().trim().max(2000).optional(),
    }),
    z.object({ type: z.literal('cadence'), cadenceId: z.string().uuid() }),
    z.object({ type: z.literal('move'), status: PlatformLeadManualStageEnum }),
    // «No interesado» de momento es perderlo con su motivo.
    z.object({
      type: z.literal('lose'),
      reasonCode: PlatformLeadManualLostReasonEnum,
      reason: z.string().trim().max(1000).optional(),
    }),
  ]),
});
export type SalesBulkLeadActionInput = z.infer<typeof SalesBulkLeadActionSchema>;
export type SalesBulkLeadAction = SalesBulkLeadActionInput['action'];

export interface SalesBulkLeadResultDto {
  done: number;
  /** Los que no se han podido tocar y por qué (los de otra cartera, sin nombre). */
  failed: { leadId: string; name: string | null; message: string }[];
}

// ----------------------------------------------------------------- clientes

export const SALES_CLIENT_FILTERS = [
  'trial',
  'trial_ending',
  'paying',
  'past_due',
  'onboarding',
  'no_contact',
  'opportunity',
] as const;
export const SalesClientFilterEnum = z.enum(SALES_CLIENT_FILTERS);
export type SalesClientFilter = z.infer<typeof SalesClientFilterEnum>;
export const SALES_CLIENT_FILTER_LABELS: Record<SalesClientFilter, string> = {
  trial: 'En prueba',
  trial_ending: 'Prueba que acaba',
  paying: 'Pagando',
  past_due: 'Con deuda',
  onboarding: 'Sin arrancar',
  no_contact: 'Sin contacto hace tiempo',
  opportunity: 'Con algo que ofrecer',
};

export const SALES_CLIENT_SORTS = [
  'name',
  'trial_end',
  'monthly',
  'last_contact',
  'last_login',
  'health',
] as const;
export const SalesClientSortEnum = z.enum(SALES_CLIENT_SORTS);
export type SalesClientSort = z.infer<typeof SalesClientSortEnum>;
export const SALES_CLIENT_SORT_LABELS: Record<SalesClientSort, string> = {
  name: 'Nombre',
  trial_end: 'Fin de la prueba',
  monthly: 'Lo que paga',
  last_contact: 'Último contacto',
  last_login: 'Último acceso',
  health: 'Salud',
};
export const SALES_CLIENT_SORT_DEFAULT_DIR: Record<SalesClientSort, 'asc' | 'desc'> = {
  name: 'asc',
  trial_end: 'asc',
  monthly: 'desc',
  last_contact: 'asc',
  last_login: 'asc',
  health: 'asc',
};

export const SalesClientsQuerySchema = z.object({
  filter: SalesClientFilterEnum.optional(),
  search: optionalQueryText(120),
  temperature: SalesLeadTemperatureFilterEnum.optional(),
  batch: optionalQueryText(120),
  sort: SalesClientSortEnum.optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});
export type SalesClientsQuery = z.infer<typeof SalesClientsQuerySchema>;
