import { z } from 'zod';

import type { UnitStatusValue } from '../facilities/schemas';

/**
 * Trasteros cedidos: el operador presta un trastero sin contrato, cobro ni
 * factura. El trastero queda «Cedido» (como si estuviera en mantenimiento) y la
 * persona entra con un código que el propietario le da en mano.
 */

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

/** Meses de una cesión o de una ampliación. */
export const UNIT_CESSION_MAX_MONTHS = 60;
/** Días antes del fin en que se avisa al equipo. */
export const UNIT_CESSION_NOTICE_DAYS = 7;

const months = z
  .number({ invalid_type_error: 'Indica los meses' })
  .int('Los meses son un número entero')
  .min(1, 'Al menos 1 mes')
  .max(UNIT_CESSION_MAX_MONTHS, `Como mucho ${UNIT_CESSION_MAX_MONTHS} meses`);

const holderName = z.string().trim().min(2, 'Escribe el nombre').max(120, 'Nombre demasiado largo');
const holderPhone = z.string().trim().max(30, 'Teléfono demasiado largo');
const notes = z.string().trim().max(2000, 'Notas demasiado largas');

export const CreateUnitCessionSchema = z
  .object({
    /** Persona a la que se presta (si no es un inquilino). */
    holderName: holderName.optional().or(z.literal('')),
    holderPhone: holderPhone.optional().or(z.literal('')),
    /** Inquilino al que se presta (opcional). */
    customerId: z.string().uuid().optional(),
    /** Desde cuándo (por defecto hoy en la zona del negocio). */
    startsOn: isoDay.optional(),
    /** Durante N meses… */
    months: months.optional(),
    /** …o hasta un día concreto. */
    endsOn: isoDay.optional(),
    notes: notes.optional().or(z.literal('')),
  })
  .refine((v) => Boolean(v.customerId) || Boolean(v.holderName && v.holderName.trim()), {
    message: 'Indica a quién se cede: su nombre o un inquilino',
    path: ['holderName'],
  })
  .refine((v) => (v.months === undefined) !== (v.endsOn === undefined), {
    message: 'Indica los meses o la fecha de fin (una de las dos)',
    path: ['months'],
  });
export type CreateUnitCessionInput = z.infer<typeof CreateUnitCessionSchema>;

export const UpdateUnitCessionSchema = z
  .object({
    /** Meses que se suman a la fecha de fin actual (aunque ya haya vencido). */
    months: months.optional(),
    /** Nueva fecha de fin. */
    endsOn: isoDay.optional(),
    holderName: holderName.optional().or(z.literal('')),
    holderPhone: holderPhone.optional().or(z.literal('')),
    /** Inquilino enlazado; null lo desenlaza. */
    customerId: z.string().uuid().nullable().optional(),
    notes: notes.optional().or(z.literal('')),
  })
  .refine((v) => !(v.months !== undefined && v.endsOn !== undefined), {
    message: 'Amplía por meses o cambia la fecha, no las dos cosas',
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

export const UnitCessionListStatusEnum = z.enum(['active', 'expiring', 'expired']);
export type UnitCessionListStatus = z.infer<typeof UnitCessionListStatusEnum>;

export interface UnitCessionAccessDto {
  credentialId: string;
  /** active · suspended · revoked… (nunca el código). */
  status: string;
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
  endsOn: string;
  notes: string | null;
  /** Días hasta el fin (0 = hoy; negativo = vencida). Solo en las vivas. */
  daysLeft: number | null;
  expired: boolean;
  previousUnitStatus: UnitStatusValue;
  endedAt: string | null;
  endedUnitStatus: UnitStatusValue | null;
  createdByName: string | null;
  endedByName: string | null;
  createdAt: string;
  /** Precio del trastero sin IVA, como referencia (no se cobra). */
  unitPriceMonthly: number;
  /** Acceso de la cesión; null si no tiene (sin control de accesos). */
  access: UnitCessionAccessDto | null;
}

/** Resumen de la cesión viva que acompaña al trastero en las listas. */
export interface UnitCessionSummaryDto {
  holderName: string;
  endsOn: string;
  expired: boolean;
}

export interface UnitCessionCodeDto {
  code: string;
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
export function cessionRemainingText(today: string, endsOn: string): string | null {
  if (endsOn < today) return null;
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
