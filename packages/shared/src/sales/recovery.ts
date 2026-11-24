import { z } from 'zod';

import {
  PLATFORM_LEAD_LOST_REASONS,
  PlatformLeadManualLostReasonEnum,
  type PlatformLeadLostReason,
} from '../admin/leads';

/**
 * No interesados y recuperación: un prospecto «no interesado» (o un cliente que
 * se da de baja) queda archivado en la cartera de su comercial con la fecha de
 * volver a intentarlo, propuesta según el motivo. «No volver a contactar» es un
 * archivado sin fecha, sin correos ni recordatorios.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

/** Meses hasta volver a intentarlo, por motivo (lo que trae la base). */
export const SALES_RECOVER_MONTHS_DEFAULT: Record<PlatformLeadLostReason, number> = {
  not_now: 6,
  price: 12,
  competitor: 12,
  no_response: 3,
  own_software: 12,
  missing_feature: 12,
  no_conversion: 12,
  churned: 12,
  other: 12,
};

export const SALES_RECOVER_MONTHS_MAX = 36;

/** Los meses guardados, completando con los de la base lo que falte o no valga. */
export function parseRecoverMonths(value: unknown): Record<PlatformLeadLostReason, number> {
  const out = { ...SALES_RECOVER_MONTHS_DEFAULT };
  if (!value || typeof value !== 'object') return out;
  for (const reason of PLATFORM_LEAD_LOST_REASONS) {
    const v = (value as Record<string, unknown>)[reason];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SALES_RECOVER_MONTHS_MAX) {
      out[reason] = v;
    }
  }
  return out;
}

/** Suma meses a una fecha AAAA-MM-DD (el 31 de un mes corto pasa al último día). */
export function addMonthsToIsoDate(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Fecha propuesta para volver a intentarlo: hoy más los meses de su motivo. */
export function proposeRecoverOn(
  today: string,
  reason: PlatformLeadLostReason,
  months: Partial<Record<PlatformLeadLostReason, number>> = SALES_RECOVER_MONTHS_DEFAULT,
): string {
  return addMonthsToIsoDate(today, months[reason] ?? SALES_RECOVER_MONTHS_DEFAULT[reason]);
}

/** «No interesado» desde el panel del comercial (también en lote). */
export const SalesArchiveLeadSchema = z.object({
  reasonCode: PlatformLeadManualLostReasonEnum,
  reason: z.string().trim().max(1000).optional().or(z.literal('')),
  /** Volver a intentarlo ese día (sin enviar: la propuesta por el motivo). */
  recoverOn: isoDate.nullable().optional(),
  /** Sin fecha, sin correos ni recordatorios. */
  doNotContact: z.boolean().optional(),
});
export type SalesArchiveLeadInput = z.infer<typeof SalesArchiveLeadSchema>;

/** Cambiar la fecha de un archivado o marcarlo «No volver a contactar». */
export const UpdateSalesArchiveSchema = z
  .object({
    recoverOn: isoDate.nullable().optional(),
    doNotContact: z.boolean().optional(),
  })
  .refine((v) => v.recoverOn !== undefined || v.doNotContact !== undefined, {
    message: 'Indica la fecha o si no hay que volver a contactarle',
  });
export type UpdateSalesArchiveInput = z.infer<typeof UpdateSalesArchiveSchema>;

/** Vistas de los archivados en «Prospectos». */
export const SALES_ARCHIVE_FILTERS = ['due', 'scheduled', 'do_not_contact'] as const;
export const SalesArchiveFilterEnum = z.enum(SALES_ARCHIVE_FILTERS);
export type SalesArchiveFilter = z.infer<typeof SalesArchiveFilterEnum>;
export const SALES_ARCHIVE_FILTER_LABELS: Record<SalesArchiveFilter, string> = {
  due: 'Para recuperar',
  scheduled: 'Con fecha',
  do_not_contact: 'No volver a contactar',
};

export interface SalesArchiveCountsDto {
  total: number;
  /** La fecha de volver a intentarlo ya ha llegado. */
  due: number;
  scheduled: number;
  doNotContact: number;
}

/** Recuperados de un comercial (Resultados y comparativa del equipo). */
export interface SalesRecoveryStatsDto {
  /** Archivados que ha vuelto a trabajar (o clientes que han vuelto) en el mes. */
  recoveredMonth: number;
  /** De ellos (y de los anteriores), los que han pagado en el mes. */
  wonMonth: number;
  /** Lo mismo en los últimos 12 meses. */
  recovered12m: number;
  won12m: number;
  /** Archivados que ya toca recuperar. */
  due: number;
}

/** Un archivado y su recuperación (para la dirección). */
export interface SalesRecoveryDto {
  id: string;
  leadId: string;
  leadName: string;
  repId: string;
  repName: string;
  repActive: boolean;
  kind: 'prospect' | 'client';
  reasonCode: PlatformLeadLostReason | null;
  archivedAt: string;
  recoverOn: string | null;
  recoveredAt: string | null;
  wonAt: string | null;
}

/** Proporción de la comisión de un cliente recuperado (decisión de la dirección). */
export const SALES_RECOVERY_COMMISSION_FACTOR = 0.5;
