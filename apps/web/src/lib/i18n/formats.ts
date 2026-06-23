import type { Formats } from 'next-intl';

/**
 * Formatos con nombre reutilizables de next-intl. Deben compartirse entre el
 * config del servidor (`request.ts`, para Server Components) y el
 * `NextIntlClientProvider` (para Client Components con `useFormatter`); si no se
 * pasan al provider, los Client Components emiten `MISSING_FORMAT`.
 *
 * `dateTime.long` lo usa el banner de prueba del dashboard
 * (`format.dateTime(date, 'long')`).
 */
export const formats: Formats = {
  dateTime: {
    long: { day: 'numeric', month: 'long', year: 'numeric' },
  },
};
