import type { FirstPaymentQuoteDto } from '@storageos/shared';

type FirstMonth = NonNullable<FirstPaymentQuoteDto['firstMonth']>;

const fmt = (iso: string, intlLocale: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(intlLocale, { timeZone: 'UTC', ...opts });

/** Fechas del primer pago mensual, listas para los textos del resumen. */
export function firstMonthLabels(fm: FirstMonth, intlLocale: string) {
  const [y, m] = fm.periodStart.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const nextStart = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return {
    // Mismo mes: «del 28 al 31 de octubre».
    from: fmt(fm.periodStart, intlLocale, { day: 'numeric' }),
    to: fmt(lastDay, intlLocale, { day: 'numeric', month: 'long' }),
    nextMonth: fmt(nextStart, intlLocale, { month: 'long' }),
  };
}
