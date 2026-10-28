import { todayInTimezone } from './format';

/**
 * Fecha de fin al cancelar una baja (o aceptar una oferta para quedarse): la
 * que tenía el contrato antes de pedirla, si aún no ha pasado. Un contrato de
 * duración fija no se vuelve indefinido por pedir la baja y arrepentirse.
 */
export function endDateAfterCancellingMoveOut(before: Date | null, now = new Date()): Date | null {
  if (!before) return null;
  return before.getTime() >= todayInTimezone('Europe/Madrid', now).getTime() ? before : null;
}
