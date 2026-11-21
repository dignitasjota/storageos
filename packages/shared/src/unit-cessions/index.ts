import { z } from 'zod';

import type { UnitStatusValue } from '../facilities/schemas';

/**
 * Trasteros cedidos: el operador presta un trastero sin contrato, cobro ni
 * factura. El trastero queda «Cedido» (como si estuviera en mantenimiento) y la
 * persona entra con un código que el propietario le da en mano.
 */

/** ¿Existe de verdad este día AAAA-MM-DD? (ni mes 13 ni 31 de febrero). */
export function isRealIsoDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD')
  .refine(isRealIsoDay, 'Esa fecha no existe');

/** Meses de una cesión o de una ampliación. */
export const UNIT_CESSION_MAX_MONTHS = 60;
/** Días antes del fin en que se avisa al equipo (por defecto). */
export const UNIT_CESSION_NOTICE_DAYS = 7;
/** Con cuántos días de antelación puede avisar una cesión. */
export const UNIT_CESSION_NOTICE_DAYS_OPTIONS = [0, 3, 7, 15, 30] as const;
/** Cesión sin fecha de fin: cada cuántos meses se recuerda al propietario. */
export const UNIT_CESSION_REVIEW_MONTHS_OPTIONS = [1, 3, 6, 12] as const;
export const UNIT_CESSION_DEFAULT_REVIEW_MONTHS = 3;
/** Días que se puede posponer el aviso de una cesión vencida. */
export const UNIT_CESSION_SNOOZE_DAYS_OPTIONS = [7, 30] as const;
/** Sin entrar en tantos días, la última entrada se marca en ámbar. */
export const UNIT_CESSION_IDLE_DAYS = 60;
/** Códigos de acceso como mucho por cesión. */
export const UNIT_CESSION_MAX_CODES = 5;

const months = z
  .number({ invalid_type_error: 'Indica los meses' })
  .int('Los meses son un número entero')
  .min(1, 'Al menos 1 mes')
  .max(UNIT_CESSION_MAX_MONTHS, `Como mucho ${UNIT_CESSION_MAX_MONTHS} meses`);

const holderName = z.string().trim().min(2, 'Escribe el nombre').max(120, 'Nombre demasiado largo');
const holderPhone = z.string().trim().max(30, 'Teléfono demasiado largo');
const notes = z.string().trim().max(2000, 'Notas demasiado largas');
const noticeDays = z
  .number({ invalid_type_error: 'Indica los días' })
  .int()
  .refine((n) => (UNIT_CESSION_NOTICE_DAYS_OPTIONS as readonly number[]).includes(n), {
    message: 'Elige 0, 3, 7, 15 o 30 días',
  });
const reviewEveryMonths = z
  .number({ invalid_type_error: 'Indica los meses' })
  .int()
  .refine((n) => (UNIT_CESSION_REVIEW_MONTHS_OPTIONS as readonly number[]).includes(n), {
    message: 'Elige 1, 3, 6 o 12 meses',
  });

/** Cuántas de estas formas de fijar el fin vienen (meses, fecha, sin fecha). */
function termCount(v: {
  months?: unknown;
  endsOn?: unknown;
  openEnded?: boolean | undefined;
}): number {
  return (
    (v.months !== undefined ? 1 : 0) +
    (v.endsOn !== undefined ? 1 : 0) +
    (v.openEnded === true ? 1 : 0)
  );
}

export const CreateUnitCessionSchema = z
  .object({
    /** Persona a la que se presta (si no es un inquilino). */
    holderName: holderName.optional().or(z.literal('')),
    holderPhone: holderPhone.optional().or(z.literal('')),
    /** Inquilino al que se presta (opcional). */
    customerId: z.string().uuid().optional(),
    /** Desde cuándo (por defecto hoy en la zona del local; nunca después de hoy). */
    startsOn: isoDay.optional(),
    /** Durante N meses… */
    months: months.optional(),
    /** …o hasta un día concreto… */
    endsOn: isoDay.optional(),
    /** …o sin fecha de fin («hasta nuevo aviso»). */
    openEnded: z.boolean().optional(),
    /** Sin fecha de fin: cada cuántos meses se recuerda (por defecto 3). */
    reviewEveryMonths: reviewEveryMonths.optional(),
    /** Días antes del fin en que avisa (por defecto 7). */
    noticeDays: noticeDays.optional(),
    notes: notes.optional().or(z.literal('')),
  })
  .refine((v) => Boolean(v.customerId) || Boolean(v.holderName && v.holderName.trim()), {
    message: 'Indica a quién se cede: su nombre o un inquilino',
    path: ['holderName'],
  })
  .refine((v) => termCount(v) === 1, {
    message: 'Indica los meses, la fecha de fin o «sin fecha de fin» (una de las tres)',
    path: ['months'],
  })
  .refine((v) => v.reviewEveryMonths === undefined || v.openEnded === true, {
    message: 'Cada cuánto recordarla solo vale para una cesión sin fecha de fin',
    path: ['reviewEveryMonths'],
  });
export type CreateUnitCessionInput = z.infer<typeof CreateUnitCessionSchema>;

export const UpdateUnitCessionSchema = z
  .object({
    /**
     * Meses que se suman a la fecha de fin; si la cesión ya había vencido,
     * cuentan desde hoy.
     */
    months: months.optional(),
    /** Nueva fecha de fin. */
    endsOn: isoDay.optional(),
    /** Pasa a no tener fecha de fin. */
    openEnded: z.literal(true).optional(),
    /** Sin fecha de fin: cada cuántos meses se recuerda. */
    reviewEveryMonths: reviewEveryMonths.optional(),
    noticeDays: noticeDays.optional(),
    holderName: holderName.optional().or(z.literal('')),
    holderPhone: holderPhone.optional().or(z.literal('')),
    /** Inquilino enlazado; null lo desenlaza. */
    customerId: z.string().uuid().nullable().optional(),
    notes: notes.optional().or(z.literal('')),
  })
  .refine((v) => termCount(v) <= 1, {
    message: 'Amplía por meses, cambia la fecha o quítala, solo una de las tres',
    path: ['months'],
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateUnitCessionInput = z.infer<typeof UpdateUnitCessionSchema>;

/** Estados en que puede quedar el trastero al terminar la cesión. */
export const UnitCessionEndStatusEnum = z.enum(['available', 'maintenance', 'blocked']);
export type UnitCessionEndStatus = z.infer<typeof UnitCessionEndStatusEnum>;

export const EndUnitCessionSchema = z.object({
  status: UnitCessionEndStatusEnum.default('available'),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});
export type EndUnitCessionInput = z.infer<typeof EndUnitCessionSchema>;

/** Posponer el aviso de una cesión vencida. */
export const SnoozeUnitCessionSchema = z.object({
  days: z
    .number()
    .int()
    .refine((n) => (UNIT_CESSION_SNOOZE_DAYS_OPTIONS as readonly number[]).includes(n), {
      message: 'Elige 7 o 30 días',
    }),
});
export type SnoozeUnitCessionInput = z.infer<typeof SnoozeUnitCessionSchema>;

/** Otro código para la misma cesión (p. ej. para su pareja). */
export const CreateUnitCessionCodeSchema = z.object({
  label: z.string().trim().max(60, 'Nombre demasiado largo').optional().or(z.literal('')),
});
export type CreateUnitCessionCodeInput = z.infer<typeof CreateUnitCessionCodeSchema>;

/** Cambiar un código de la cesión: acceso 24 h y su nombre. */
export const UpdateUnitCessionCodeSchema = z
  .object({
    /** Salta el toque de queda del local. */
    bypassCurfew: z.boolean().optional(),
    label: z.string().trim().max(60, 'Nombre demasiado largo').optional().or(z.literal('')),
  })
  .refine((v) => v.bypassCurfew !== undefined || v.label !== undefined, {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateUnitCessionCodeInput = z.infer<typeof UpdateUnitCessionCodeSchema>;

/**
 * Estados de la lista de cesiones: `active` = todas las vivas; `on_time` = en
 * plazo (y las que no tienen fecha de fin); `expiring` = vencen pronto (con el
 * día de fin); `due_today` = vencen hoy; `expired` = vencidas; `ended` =
 * terminadas; `all` = todas.
 */
export const UnitCessionListStatusEnum = z.enum([
  'active',
  'on_time',
  'expiring',
  'due_today',
  'expired',
  'ended',
  'all',
]);
export type UnitCessionListStatus = z.infer<typeof UnitCessionListStatusEnum>;

/** En qué punto está una cesión. */
export type UnitCessionState = 'on_time' | 'expiring' | 'due_today' | 'expired' | 'ended';

export const UNIT_CESSION_STATE_LABELS: Record<UnitCessionState, string> = {
  on_time: 'En plazo',
  expiring: 'Vence pronto',
  due_today: 'Vence hoy',
  expired: 'Vencida',
  ended: 'Terminada',
};

export interface UnitCessionAccessDto {
  credentialId: string;
  /** active · suspended · revoked… (nunca el código). */
  status: string;
  /** Nombre del código («Cesión» el principal). */
  label: string | null;
  /** El código principal de la cesión (el que se crea al cederla). */
  primary: boolean;
  /** Acceso 24 h: salta el toque de queda del local. */
  bypassCurfew: boolean;
  /** Última entrada permitida con este código (o null si no ha entrado). */
  lastUsedAt: string | null;
}

/** Respuesta de «Pasar a contrato»: el asistente con el trastero ya elegido. */
export interface UnitCessionToContractDto {
  url: string;
  cession: UnitCessionDto;
}

export interface UnitCessionNewCodeDto {
  credentialId: string;
  code: string;
}

export interface UnitCessionDto {
  id: string;
  unitId: string;
  unitCode: string;
  facilityId: string;
  facilityName: string;
  /** A quién se cede: su nombre (o el del inquilino enlazado). */
  holderName: string;
  holderPhone: string | null;
  customerId: string | null;
  customerName: string | null;
  startsOn: string;
  /** Null = sin fecha de fin («hasta nuevo aviso»). */
  endsOn: string | null;
  notes: string | null;
  /** Días hasta el fin (0 = vence hoy; negativo = vencida). Solo en las vivas con fecha. */
  daysLeft: number | null;
  /** Vencida: desde el día siguiente al de fin (el último día sigue en plazo). */
  expired: boolean;
  /** En plazo, vence pronto, vence hoy, vencida o terminada. */
  state: UnitCessionState;
  /** Días antes del fin en que avisa. */
  noticeDays: number;
  /** Sin fecha de fin: cada cuántos meses se recuerda. */
  reviewEveryMonths: number | null;
  /** Aviso de vencida pospuesto hasta (null si no). */
  snoozedUntil: string | null;
  /** Motivo con que se terminó. */
  endedReason: string | null;
  previousUnitStatus: UnitStatusValue;
  endedAt: string | null;
  endedUnitStatus: UnitStatusValue | null;
  createdByName: string | null;
  endedByName: string | null;
  createdAt: string;
  /** Precio del trastero sin IVA, como referencia (no se cobra). */
  unitPriceMonthly: number;
  /**
   * Acceso principal de la cesión; null si no tiene (sin control de accesos).
   * `lastUsedAt` es la última entrada con cualquiera de sus códigos.
   */
  access: UnitCessionAccessDto | null;
  /** Todos los códigos vivos de la cesión (el principal el primero). */
  codes: UnitCessionAccessDto[];
}

/** Resumen de la cesión viva que acompaña al trastero en las listas. */
export interface UnitCessionSummaryDto {
  holderName: string;
  /** Null = sin fecha de fin. */
  endsOn: string | null;
  expired: boolean;
}

export interface UnitCessionCodeDto {
  code: string;
}

/**
 * El día de fin todavía está en plazo («vence hoy»): una cesión está vencida
 * desde el día siguiente. `daysLeft` = días de hoy al fin.
 */
export function cessionIsExpired(daysLeft: number): boolean {
  return daysLeft < 0;
}

/**
 * Vence pronto: del día de fin (incluido) a los `noticeDays` días anteriores
 * (7 por defecto; con 0, solo el día de fin).
 */
export function cessionIsExpiring(
  daysLeft: number,
  noticeDays: number = UNIT_CESSION_NOTICE_DAYS,
): boolean {
  return daysLeft >= 0 && daysLeft <= noticeDays;
}

/** Estado de una cesión: sin fecha de fin está siempre en plazo. */
export function cessionState(args: {
  ended: boolean;
  daysLeft: number | null;
  noticeDays: number;
}): UnitCessionState {
  if (args.ended) return 'ended';
  if (args.daysLeft === null) return 'on_time';
  if (cessionIsExpired(args.daysLeft)) return 'expired';
  if (args.daysLeft === 0) return 'due_today';
  if (cessionIsExpiring(args.daysLeft, args.noticeDays)) return 'expiring';
  return 'on_time';
}

/**
 * Nueva fecha de fin al ampliar por meses: desde la fecha de fin si aún no ha
 * vencido y desde hoy si ya venció o no tenía fecha (si no, la ampliación podía
 * dejarla vencida).
 */
export function cessionExtendedEnd(
  today: string,
  endsOn: string | null,
  monthsToAdd: number,
): string {
  return addMonthsToDay(endsOn === null || endsOn < today ? today : endsOn, monthsToAdd);
}

/**
 * Cesión sin fecha de fin: día del próximo recordatorio (cada `every` meses
 * desde el último, o desde el inicio si nunca se ha recordado).
 */
export function cessionNextReview(lastReviewOrStart: string, every: number): string {
  return addMonthsToDay(lastReviewOrStart, every);
}

/** Meses enteros de `from` a `to` (AAAA-MM-DD): «desde hace N meses». */
export function cessionMonthsBetween(from: string, to: string): number {
  let n = 0;
  while (addMonthsToDay(from, n + 1) <= to) n += 1;
  return n;
}

/** Días naturales de `from` a `to` (fechas AAAA-MM-DD o Date a medianoche UTC). */
export function cessionDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Tiempo que queda hasta una fecha en palabras: «2 meses y 5 días», «12 días».
 * `today` y `endsOn` en AAAA-MM-DD. Si ya pasó, devuelve null.
 */
export function cessionRemainingText(today: string, endsOn: string | null): string | null {
  if (endsOn === null || endsOn < today) return null;
  // Meses enteros: el mayor N con «hoy + N meses» (ajustado a fin de mes) no
  // posterior al fin; los días son lo que sobra.
  let monthsLeft = 0;
  while (addMonthsToDay(today, monthsLeft + 1) <= endsOn) monthsLeft += 1;
  const days = cessionDaysBetween(addMonthsToDay(today, monthsLeft), endsOn);
  const parts: string[] = [];
  if (monthsLeft > 0) parts.push(monthsLeft === 1 ? '1 mes' : `${monthsLeft} meses`);
  if (days > 0 || parts.length === 0) parts.push(days === 1 ? '1 día' : `${days} días`);
  return parts.join(' y ');
}

/** Suma meses a una fecha AAAA-MM-DD; el 31 de enero + 1 mes es el 28 (o 29) de febrero. */
export function addMonthsToDay(day: string, monthsToAdd: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + monthsToAdd, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
