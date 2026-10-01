/**
 * Formato legible (es-ES) para las variables de las plantillas de correo: los
 * textos que ve el inquilino no deben llevar `121.00` ni `2026-10-01`.
 */

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

/** 121 → «121,00 €». */
export function formatEur(amount: number | string | { toString(): string }): string {
  const n = typeof amount === 'number' ? amount : Number(amount.toString());
  return EUR.format(Number.isFinite(n) ? n : 0);
}

/** Fecha → «1 de octubre de 2026» (en la zona del local; Madrid por defecto). */
export function formatDateLong(date: Date, timeZone = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(date);
}
