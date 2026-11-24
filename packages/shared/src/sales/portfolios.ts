import { z } from 'zod';

import {
  PlatformLeadStageEnum,
  type PlatformLeadActivityType,
  type PlatformLeadStage,
} from '../admin/leads';

import { SalesLeadTemperatureFilterEnum } from './portfolio';

import type { SalesAccountDto, SalesLeadDto } from './index';

/**
 * Carteras (solo la dirección): todos los prospectos y clientes de todos los
 * comerciales en una tabla, la ficha completa con su cronología y lo que la
 * dirección puede hacer con cada uno (nota al comercial, reasignar, editar la
 * ficha comercial, mover de fase, archivar y recuperar).
 */

// ------------------------------------------------------------------ lista

export const SALES_PORTFOLIO_SORTS = [
  'untouched',
  'priority',
  'value',
  'next_step',
  'rep',
  'stage',
  'assigned',
  'updated',
] as const;
export const SalesPortfolioSortEnum = z.enum(SALES_PORTFOLIO_SORTS);
export type SalesPortfolioSort = z.infer<typeof SalesPortfolioSortEnum>;
export const SALES_PORTFOLIO_SORT_LABELS: Record<SalesPortfolioSort, string> = {
  untouched: 'Días sin tocar',
  priority: 'Prioridad',
  value: 'Cuota prevista',
  next_step: 'Siguiente paso',
  rep: 'Comercial',
  stage: 'Fase',
  assigned: 'Asignado el',
  updated: 'Último cambio',
};
/** Dirección por defecto de cada orden (lo más útil primero). */
export const SALES_PORTFOLIO_SORT_DEFAULT_DIR: Record<SalesPortfolioSort, 'asc' | 'desc'> = {
  untouched: 'desc',
  priority: 'desc',
  value: 'desc',
  next_step: 'asc',
  rep: 'asc',
  stage: 'asc',
  assigned: 'desc',
  updated: 'desc',
};

/** Activos (sin los archivados), solo los archivados o todos. */
export const SALES_PORTFOLIO_SCOPES = ['active', 'archived', 'all'] as const;
export const SalesPortfolioScopeEnum = z.enum(SALES_PORTFOLIO_SCOPES);
export type SalesPortfolioScope = z.infer<typeof SalesPortfolioScopeEnum>;
export const SALES_PORTFOLIO_SCOPE_LABELS: Record<SalesPortfolioScope, string> = {
  active: 'Activos',
  archived: 'Archivados',
  all: 'Activos y archivados',
};

/** Prospectos (sin cuenta), clientes (con cuenta) o todos. */
export const SALES_PORTFOLIO_KINDS = ['all', 'prospects', 'clients'] as const;
export const SalesPortfolioKindEnum = z.enum(SALES_PORTFOLIO_KINDS);
export type SalesPortfolioKind = z.infer<typeof SalesPortfolioKindEnum>;
export const SALES_PORTFOLIO_KIND_LABELS: Record<SalesPortfolioKind, string> = {
  all: 'Prospectos y clientes',
  prospects: 'Solo prospectos',
  clients: 'Solo clientes',
};

/** Comercial elegido: uno, «sin comercial» o (sin indicar) todos los que tienen. */
export const SALES_PORTFOLIO_NO_REP = 'none';

const optionalQueryText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const queryBool = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const SalesPortfoliosQuerySchema = z.object({
  rep: z.union([z.literal(SALES_PORTFOLIO_NO_REP), z.string().uuid()]).optional(),
  search: optionalQueryText(120),
  status: PlatformLeadStageEnum.optional(),
  batch: optionalQueryText(120),
  temperature: SalesLeadTemperatureFilterEnum.optional(),
  /** Sin contacto con el cliente en estos días (o nunca). */
  untouchedDays: z.coerce.number().int().min(1).max(730).optional(),
  /** Prospectos abiertos con los que nadie ha hablado todavía. */
  neverContacted: queryBool,
  scope: SalesPortfolioScopeEnum.optional(),
  kind: SalesPortfolioKindEnum.optional(),
  sort: SalesPortfolioSortEnum.optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  cursor: optionalQueryText(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type SalesPortfoliosQuery = z.infer<typeof SalesPortfoliosQuerySchema>;

/** Filas del CSV como mucho. */
export const SALES_PORTFOLIO_EXPORT_MAX = 5000;

/** Un prospecto o cliente de la cartera de un comercial, visto por la dirección. */
export interface SalesPortfolioRowDto extends SalesLeadDto {
  salesRepId: string | null;
  /** Su comercial sigue activo (null = sin comercial). */
  salesRepActive: boolean | null;
  /** Último contacto con el cliente (llamada, WhatsApp, reunión, demo o correo). */
  lastContactAt: string | null;
  /** Nadie ha hablado aún con él. */
  neverContacted: boolean;
  /** Días desde el último contacto o, sin contacto, desde que lo lleva (o desde su alta). */
  daysUntouched: number;
  /** Cómo llegó a su comercial (enlace, reparto de la dirección…). */
  assignedSource: string | null;
  /** Lo que paga al mes si ya es cliente (plan y extras, sin IVA). */
  clientMonthly: number | null;
}

export interface SalesPortfolioListDto {
  items: SalesPortfolioRowDto[];
  /** Cuántos cumplen los filtros (todas las páginas). */
  total: number;
  nextCursor: string | null;
  /**
   * Embudo de los activos por fase con los filtros de comercial, lote y
   * búsqueda (sin los de fase, temperatura ni días).
   */
  funnel: Record<PlatformLeadStage, number>;
  /** Archivados con esos mismos filtros. */
  archived: number;
  /** Prospectos abiertos con los que nadie ha hablado todavía. */
  untouched: number;
  /** Comerciales con su cartera (activos y archivados). */
  reps: { id: string; name: string; isActive: boolean; count: number }[];
  /** Prospectos y clientes sin comercial (solo los que se trabajan). */
  noRep: number;
  batches: { name: string; count: number }[];
}

// ------------------------------------------------------------------ ficha

export const SALES_TIMELINE_KINDS = [
  'activity',
  'followup',
  'appointment',
  'quote',
  'cadence',
  'assignment',
  'archive',
] as const;
export type SalesTimelineKind = (typeof SALES_TIMELINE_KINDS)[number];
export const SALES_TIMELINE_KIND_LABELS: Record<SalesTimelineKind, string> = {
  activity: 'Actividad',
  followup: 'Seguimiento',
  appointment: 'Cita',
  quote: 'Propuesta',
  cadence: 'Cadencia',
  assignment: 'Reparto',
  archive: 'Archivo',
};

export interface SalesTimelineEntryDto {
  id: string;
  at: string;
  kind: SalesTimelineKind;
  /** Tipo de actividad (llamada, nota, correo…) si es una actividad. */
  activityType: PlatformLeadActivityType | null;
  title: string;
  detail: string | null;
  author: string | null;
  /** Lo hizo la dirección. */
  byDirection: boolean;
}

/** La ficha completa de una cuenta para la dirección. */
export interface SalesPortfolioDetailDto {
  account: SalesAccountDto;
  rep: { id: string; fullName: string; isActive: boolean } | null;
  assignedAt: string | null;
  assignedSource: string | null;
  lastContactAt: string | null;
  neverContacted: boolean;
  daysUntouched: number;
  /** Todo lo que ha pasado, de lo último a lo primero. */
  timeline: SalesTimelineEntryDto[];
}

/** Nota de la dirección al comercial (queda en la cronología y le llega un aviso). */
export const SalesDirectionNoteSchema = z.object({
  content: z.string().trim().min(2, 'Escribe la nota').max(2000),
});
export type SalesDirectionNoteInput = z.infer<typeof SalesDirectionNoteSchema>;

/** Pasar la cuenta a otro comercial o dejarla sin comercial. */
export const SalesDirectionReassignSchema = z.object({
  repId: z.string().uuid().nullable(),
});
export type SalesDirectionReassignInput = z.infer<typeof SalesDirectionReassignSchema>;
