import { z } from 'zod';

import { OpeningHoursSchema } from '../facilities/schemas';

/** Días cerrados (festivos) que caben en un horario de atención. */
export const MAX_CLOSED_DATES = 60;

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD')
  .refine((d) => {
    const parsed = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
  }, 'Esa fecha no existe');

/**
 * Horario de atención del equipo (Mensajes, asistente de WhatsApp y chat de la
 * web): las horas de cada día, con un segundo turno opcional (`open2`/`close2`)
 * para el horario partido, y los días cerrados (festivos, vacaciones), que
 * mandan sobre el de la semana. Se guarda en el mismo JSON de siempre: un
 * horario sin `closedDates` sigue valiendo tal cual.
 */
export const TeamHoursSchema = OpeningHoursSchema.extend({
  closedDates: z
    .array(isoDay)
    .max(MAX_CLOSED_DATES, `Como mucho ${MAX_CLOSED_DATES} días cerrados`)
    .optional(),
});
export type TeamHours = z.infer<typeof TeamHoursSchema>;

/**
 * Deja los días cerrados ordenados, sin repetir y sin los que ya han pasado
 * (`today` = hoy en la zona del negocio, `AAAA-MM-DD`). Se aplica al guardar.
 */
export function pruneClosedDates(dates: readonly string[] | undefined, today: string): string[] {
  return [...new Set(dates ?? [])].filter((d) => d >= today).sort();
}

/** El horario con sus días cerrados limpios (o sin el campo si no queda ninguno). */
export function normalizeTeamHours<T extends TeamHours>(hours: T, today: string): T {
  const { closedDates, ...rest } = hours;
  const pruned = pruneClosedDates(closedDates, today);
  return (pruned.length > 0 ? { ...rest, closedDates: pruned } : rest) as T;
}

/** Fecha de calendario (`AAAA-MM-DD`) de `at` en la zona `timeZone`. */
export function calendarDateIn(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
