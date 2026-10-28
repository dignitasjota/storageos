import { z } from 'zod';

/**
 * Reserva anticipada de trasteros en locales que aún no han abierto.
 *
 * El cliente firma y paga la primera mensualidad y la fianza. El alquiler
 * empieza el día de apertura del local (que puede no estar fijado al reservar)
 * y la mensualidad pagada cubre el primer mes desde ese día.
 */

/** Días de desistimiento de un contrato a distancia (art. 102 TRLGDCU). */
export const PRE_OPENING_WITHDRAWAL_DAYS = 14;
/** Plazo por defecto (meses desde la firma) para abrir antes de que el cliente pueda irse con todo. */
export const DEFAULT_PRE_OPENING_MAX_MONTHS = 6;

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;

/** Suma días a una fecha `YYYY-MM-DD`. */
export function addDaysYmd(date: string, days: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Suma meses a una fecha `YYYY-MM-DD` (31 ene + 1 mes → 28 feb). */
export function addMonthsYmd(date: string, months: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

export type PreOpeningCancelReason =
  /** Dentro de los 14 días desde la firma: se devuelve todo. */
  | 'withdrawal'
  /** El local no abrió antes de la fecha límite: se devuelve todo. */
  | 'not_opened_in_time'
  /** Cancelación ordinaria antes de empezar: se devuelve la mensualidad y se retiene la fianza. */
  | 'standard';

export interface PreOpeningCancelOutcome {
  /** Ya empezó el alquiler: se da de baja como cualquier contrato. */
  allowed: boolean;
  reason: PreOpeningCancelReason | null;
  refundRent: boolean;
  refundDeposit: boolean;
  /** Último día del plazo de desistimiento (`YYYY-MM-DD`). */
  withdrawalEndsOn: string;
}

/**
 * Qué se devuelve al cancelar una reserva anticipada. `signedOn`, `today` y
 * `deadline` son días de calendario (`YYYY-MM-DD`) en la zona del local.
 */
export function preOpeningCancelOutcome(args: {
  signedOn: string;
  today: string;
  deadline: string | null;
  started: boolean;
}): PreOpeningCancelOutcome {
  const withdrawalEndsOn = addDaysYmd(args.signedOn, PRE_OPENING_WITHDRAWAL_DAYS);
  if (args.started) {
    return {
      allowed: false,
      reason: null,
      refundRent: false,
      refundDeposit: false,
      withdrawalEndsOn,
    };
  }
  if (args.today <= withdrawalEndsOn) {
    return {
      allowed: true,
      reason: 'withdrawal',
      refundRent: true,
      refundDeposit: true,
      withdrawalEndsOn,
    };
  }
  if (args.deadline && args.today > args.deadline) {
    return {
      allowed: true,
      reason: 'not_opened_in_time',
      refundRent: true,
      refundDeposit: true,
      withdrawalEndsOn,
    };
  }
  return {
    allowed: true,
    reason: 'standard',
    refundRent: true,
    refundDeposit: false,
    withdrawalEndsOn,
  };
}

/** PUT /facilities/:id/opening — local en «próxima apertura». */
export const UpdateFacilityOpeningSchema = z.object({
  preOpening: z.boolean(),
  /** Fecha de apertura prevista; null = aún sin fecha. */
  openingDate: z.string().regex(ymdRe).nullable(),
  maxMonths: z.number().int().min(1).max(36).default(DEFAULT_PRE_OPENING_MAX_MONTHS),
});
export type UpdateFacilityOpeningInput = z.infer<typeof UpdateFacilityOpeningSchema>;

export interface FacilityOpeningDto {
  preOpening: boolean;
  openingDate: string | null;
  maxMonths: number;
  /** Reservas anticipadas firmadas que aún no han empezado. */
  reservations: number;
}

export interface FacilityOpeningResultDto extends FacilityOpeningDto {
  /** Reservas a las que se ha movido la fecha de inicio. */
  moved: number;
  /** Reservas que han empezado (el local abre hoy o ya abrió). */
  started: number;
}

/** POST …/cancel-pre-opening */
export const CancelPreOpeningSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelPreOpeningInput = z.infer<typeof CancelPreOpeningSchema>;

/** Lo que pasaría al cancelar la reserva ahora mismo. */
export interface PreOpeningCancelPreviewDto extends PreOpeningCancelOutcome {
  /** Primera mensualidad cobrada que se devolvería (IVA incluido). */
  rentAmount: number;
  /** Fianza cobrada. */
  depositAmount: number;
}

/** Datos de la reserva anticipada de un contrato (null si no lo es). */
export interface ContractPreOpeningDto {
  /** La fecha de apertura está fijada (si no, la fecha de inicio es provisional). */
  dateConfirmed: boolean;
  /** Fecha de apertura prevista, si está fijada. */
  openingDate: string | null;
  /** Fecha límite: sin abrir antes, el inquilino puede cancelar con devolución total. */
  deadline: string | null;
  /** Día en que empezó (acceso y facturación), o null si aún no. */
  startedAt: string | null;
}
