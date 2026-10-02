/**
 * Formato legible para las variables de las plantillas de correo: los textos
 * que ve el inquilino no deben llevar `121.00` ni `2026-10-01`. En el idioma
 * del inquilino (`es` por defecto, `en`).
 */

export type EmailLocale = 'es' | 'en';

const INTL_LOCALE: Record<EmailLocale, string> = { es: 'es-ES', en: 'en-GB' };

/** Idioma de correo a partir del `locale` guardado del inquilino. */
export function emailLocale(locale: string | null | undefined): EmailLocale {
  return locale === 'en' ? 'en' : 'es';
}

/** 121 → «121,00 €» (es) / «€121.00» (en). */
export function formatEur(
  amount: number | string | { toString(): string },
  locale: EmailLocale = 'es',
): string {
  const n = typeof amount === 'number' ? amount : Number(amount.toString());
  return new Intl.NumberFormat(INTL_LOCALE[locale], { style: 'currency', currency: 'EUR' }).format(
    Number.isFinite(n) ? n : 0,
  );
}

/** Fecha → «1 de octubre de 2026» / «1 October 2026» (zona Madrid por defecto). */
export function formatDateLong(
  date: Date,
  timeZone = 'Europe/Madrid',
  locale: EmailLocale = 'es',
): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(date);
}
