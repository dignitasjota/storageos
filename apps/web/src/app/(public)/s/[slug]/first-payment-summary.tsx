'use client';

import { useTranslations } from 'next-intl';

import { intlLocaleFor, type PublicWebLocale } from './i18n/messages';

import type { FirstPaymentQuoteDto } from '@storageos/shared';

function money(n: number, locale: PublicWebLocale): string {
  return n.toLocaleString(intlLocaleFor(locale), { style: 'currency', currency: 'EUR' });
}

/**
 * Desglose de lo que se paga al activar el contrato: alquiler de los meses
 * elegidos, cupón, IVA, seguro y fianza. Lo usan la reserva online y la firma.
 */
export function FirstPaymentSummary({
  quote,
  locale,
}: {
  quote: FirstPaymentQuoteDto;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.book');
  const vat = quote.rentTotalWithVat - quote.rentTotal;
  const monthlyWithVat = quote.monthlyPrice * (1 + quote.vatRate / 100);
  const code = quote.coupon?.valid ? quote.coupon.code : null;
  const row = (label: string, value: string, strong = false) => (
    <div className="flex items-center justify-between gap-3">
      <span className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">{t('summaryTitle')}</p>
      {row(t('summaryRent', { count: quote.months }), money(quote.rentSubtotal, locale))}
      {code &&
        quote.discountAmount > 0 &&
        row(
          quote.freeMonths > 0
            ? t('summaryFreeMonths', { count: quote.freeMonths, code })
            : t('summaryCoupon', { code }),
          `−${money(quote.discountAmount, locale)}`,
        )}
      {quote.vatRate > 0 && row(t('summaryVat', { rate: quote.vatRate }), money(vat, locale))}
      {quote.insuranceWithVat > 0 &&
        row(t('summaryInsurance'), money(quote.insuranceWithVat, locale))}
      {quote.deposit > 0 && row(t('summaryDeposit'), money(quote.deposit, locale))}
      <div className="border-t pt-1.5">
        {row(t('summaryTotal'), money(quote.totalToPay, locale), true)}
      </div>
      <p className="pt-1 text-xs text-muted-foreground">
        {quote.prorated
          ? t('summaryProrated')
          : t('summaryAfter', { price: money(monthlyWithVat, locale) })}
      </p>
    </div>
  );
}
