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

/**
 * Fecha de hoy en una zona horaria, como fecha UTC a medianoche (para columnas
 * `DATE`). A las 00:30 del día 1 en Madrid ya es el día 1, aunque en UTC sea
 * todavía el día anterior.
 */
export function todayInTimezone(timeZone = 'Europe/Madrid', now = new Date()): Date {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

/** Diferencia (ms) entre la hora local de una zona y UTC en un instante. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Instante en que empieza el día `YYYY-MM-DD` en una zona horaria (por defecto
 * Madrid). Para filtrar columnas con hora (cobros, devoluciones…) por días
 * locales: un cobro a las 00:30 del día 1 en Madrid es del día 1, aunque en
 * UTC sea todavía el día anterior. Las columnas `DATE` no lo necesitan.
 */
export function zonedDayStart(day: string, timeZone = 'Europe/Madrid'): Date {
  const [y, m, d] = day.split('-').map(Number);
  const utcMidnight = Date.UTC(y ?? NaN, (m ?? NaN) - 1, d ?? NaN);
  if (Number.isNaN(utcMidnight)) return new Date(NaN);
  let t = utcMidnight - zoneOffsetMs(utcMidnight, timeZone);
  // Cambio de hora entre la medianoche UTC y la local: se recalcula.
  const second = utcMidnight - zoneOffsetMs(t, timeZone);
  if (second !== t) t = second;
  return new Date(t);
}

/** Inicio del día siguiente a `YYYY-MM-DD` en la zona (límite exclusivo). */
export function zonedNextDayStart(day: string, timeZone = 'Europe/Madrid'): Date {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y ?? NaN, (m ?? NaN) - 1, (d ?? NaN) + 1));
  if (Number.isNaN(next.getTime())) return new Date(NaN);
  return zonedDayStart(next.toISOString().slice(0, 10), timeZone);
}
