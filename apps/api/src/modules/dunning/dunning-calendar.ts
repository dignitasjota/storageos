import type { DunningActionType } from '@storageos/database';

export interface DunningStep {
  daysAfter: number;
  type: DunningActionType;
}

/**
 * Calendario del escalado de impagos: días desde el vencimiento (o desde la
 * devolución del cobro, al empezar de cero) y qué se hace ese día.
 */
export function dunningCalendar(
  lateFee: { enabled: boolean; graceDays: number },
  access: { mode: string; days: number } = { mode: 'all', days: 14 },
): DunningStep[] {
  const calendar: DunningStep[] = [
    { daysAfter: 1, type: 'email_reminder' },
    // Segundo aviso: tipo propio (el índice único es por tipo; con el mismo
    // tipo que el primero no se llegaba a programar nunca).
    { daysAfter: 7, type: 'email_reminder_final' },
    { daysAfter: 30, type: 'legal_notice' },
  ];
  // Corte del acceso: lo decide cada negocio, y puede no cortar nunca.
  if (access.mode !== 'none') calendar.push({ daysAfter: access.days, type: 'access_block' });
  // Recargo por mora: solo si el tenant lo activó (opt-in), a los N días.
  if (lateFee.enabled) calendar.push({ daysAfter: lateFee.graceDays, type: 'late_fee' });
  return calendar;
}
