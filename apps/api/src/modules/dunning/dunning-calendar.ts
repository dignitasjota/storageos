import type { DunningActionType } from '@storageos/database';

export interface DunningStep {
  daysAfter: number;
  type: DunningActionType;
}

/**
 * Calendario del escalado de impagos: días desde el vencimiento (o desde la
 * devolución del cobro, al empezar de cero) y qué se hace ese día.
 */
export function dunningCalendar(lateFee: { enabled: boolean; graceDays: number }): DunningStep[] {
  const calendar: DunningStep[] = [
    { daysAfter: 1, type: 'email_reminder' },
    // Segundo aviso: tipo propio (el índice único es por tipo; con el mismo
    // tipo que el primero no se llegaba a programar nunca).
    { daysAfter: 7, type: 'email_reminder_final' },
    { daysAfter: 14, type: 'access_block' },
    { daysAfter: 30, type: 'legal_notice' },
  ];
  // Recargo por mora: solo si el tenant lo activó (opt-in), a los N días.
  if (lateFee.enabled) calendar.push({ daysAfter: lateFee.graceDays, type: 'late_fee' });
  return calendar;
}
