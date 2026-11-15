import { isWithinHours, type OpeningHours } from '@storageos/shared';

const STEP_MS = 15 * 60_000;
/** Más allá no se busca (un horario vacío no deja nunca de contar). */
const MAX_DAYS = 30;

/**
 * Momento en que se cumplen `hours` horas de atención desde `start`: solo
 * cuentan los ratos dentro del horario (en la zona del negocio). Va de 15 en
 * 15 minutos: de sobra para un aviso.
 */
export function addBusinessHours(
  start: Date,
  hours: number,
  schedule: OpeningHours,
  timeZone: string,
): Date {
  let remaining = hours * 3_600_000;
  let t = start.getTime();
  const end = t + MAX_DAYS * 86_400_000;
  while (remaining > 0 && t < end) {
    if (isWithinHours(schedule, timeZone, new Date(t))) remaining -= STEP_MS;
    t += STEP_MS;
  }
  return new Date(t);
}
