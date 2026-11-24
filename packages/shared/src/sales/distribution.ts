import { z } from 'zod';

import { ImportFormatEnum } from '../imports/schemas';

/**
 * Reparto de prospectos desde la dirección: un fichero (CSV o Excel) o los
 * leads elegidos en la lista, a un comercial, según una columna del fichero o
 * a partes iguales entre varios. Todo con vista previa antes de confirmar.
 */

/** single = todo a un comercial · column = columna «comercial» · even = a partes iguales. */
export const SALES_DISTRIBUTION_MODES = ['single', 'column', 'even'] as const;
export type SalesDistributionMode = (typeof SALES_DISTRIBUTION_MODES)[number];

export const SALES_DISTRIBUTION_MODE_LABELS: Record<SalesDistributionMode, string> = {
  single: 'Todo a un comercial',
  column: 'Según la columna «comercial» del fichero',
  even: 'A partes iguales entre varios',
};

/** Nombre del lote: sin espacios de más y como mucho 80 caracteres. */
export const SALES_BATCH_MAX = 80;

export function normalizeSalesBatch(raw: string | null | undefined): string | null {
  const v = (raw ?? '').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, SALES_BATCH_MAX) : null;
}

const targetFields = {
  repId: z.string().uuid().optional(),
  repIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  batch: z.string().trim().max(SALES_BATCH_MAX).optional().or(z.literal('')),
  /** false = solo la vista previa. */
  commit: z.boolean().default(false),
};

function refineTarget(
  v: { mode: SalesDistributionMode; repId?: string | undefined; repIds?: string[] | undefined },
  ctx: z.RefinementCtx,
) {
  if (v.mode === 'single' && !v.repId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Elige el comercial', path: ['repId'] });
  }
  if (v.mode === 'even' && !v.repIds?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Elige al menos un comercial',
      path: ['repIds'],
    });
  }
}

/** Importar un fichero de prospectos y repartirlo. */
export const SalesBulkImportSchema = z
  .object({
    csv: z.string().min(1).max(2_000_000),
    format: ImportFormatEnum.default('csv'),
    mode: z.enum(SALES_DISTRIBUTION_MODES),
    ...targetFields,
  })
  .superRefine(refineTarget);
export type SalesBulkImportInput = z.infer<typeof SalesBulkImportSchema>;

/** Repartir leads que ya están en TrasterOS (selección de la lista de leads). */
export const SalesDistributeLeadsSchema = z
  .object({
    leadIds: z.array(z.string().uuid()).min(1).max(500),
    mode: z.enum(['single', 'even']),
    ...targetFields,
  })
  .superRefine(refineTarget);
export type SalesDistributeLeadsInput = z.infer<typeof SalesDistributeLeadsSchema>;

/**
 * Qué pasa con cada fila:
 * - new: contacto nuevo, se da de alta para el comercial.
 * - assign: ya estaba en TrasterOS sin comercial: se le asigna.
 * - taken: ya lo lleva un comercial (otro o el mismo): no se toca.
 * - customer: ya tiene cuenta (prueba o cliente): se omite.
 * - error: falta algo o no se entiende.
 */
export const SALES_DISTRIBUTION_ROW_STATUSES = [
  'new',
  'assign',
  'taken',
  'customer',
  'error',
] as const;
export type SalesDistributionRowStatus = (typeof SALES_DISTRIBUTION_ROW_STATUSES)[number];

export const SALES_DISTRIBUTION_ROW_STATUS_LABELS: Record<SalesDistributionRowStatus, string> = {
  new: 'Nuevo',
  assign: 'Ya existía, sin comercial',
  taken: 'Ya lo lleva un comercial',
  customer: 'Ya es cliente',
  error: 'Con error',
};

export interface SalesDistributionRowDto {
  /** Línea del fichero (null al repartir leads de la lista). */
  line: number | null;
  /** El lead que ya existía (o el creado, al confirmar). */
  leadId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  status: SalesDistributionRowStatus;
  /** A quién va (new, assign) o quién lo lleva (taken). */
  repId: string | null;
  repName: string | null;
  /** Por qué no se reparte (o el error). */
  message: string | null;
}

export interface SalesDistributionResultDto {
  batch: string | null;
  committed: boolean;
  rows: SalesDistributionRowDto[];
  summary: {
    total: number;
    /** Nuevos + ya existentes sin comercial. */
    toAssign: number;
    new: number;
    assign: number;
    taken: number;
    customers: number;
    errors: number;
  };
  /** Cuántos le tocan a cada comercial (o le han tocado, al confirmar). */
  byRep: { repId: string; repName: string; count: number }[];
  /** Repartidos de verdad (solo al confirmar). */
  assigned: number;
}

/** Resultado de un lote: lo repartido y en qué fase está cada prospecto ahora. */
export interface SalesBatchDto {
  name: string;
  total: number;
  /** Aún con un comercial. */
  withRep: number;
  reps: number;
  new: number;
  contacted: number;
  interested: number;
  trial: number;
  customer: number;
  lost: number;
  /** Aún sin abrir por su comercial. */
  unseen: number;
  firstAssignedAt: string | null;
  lastAssignedAt: string | null;
}

/** Cabeceras de la columna del comercial (sin tildes, espacios ni mayúsculas). */
export const SALES_REP_COLUMN_ALIASES = [
  'comercial',
  'vendedor',
  'codigocomercial',
  'codigo',
  'comercialasignado',
  'asignadoa',
  'emailcomercial',
  'correocomercial',
  'rep',
  'salesrep',
  'salescode',
] as const;
