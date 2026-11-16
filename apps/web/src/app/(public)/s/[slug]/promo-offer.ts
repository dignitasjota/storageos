import type { PublicActivePromotionDto } from '@storageos/shared';
import type { useTranslations } from 'next-intl';

type PromoT = ReturnType<typeof useTranslations<'publicWeb.promo'>>;

/**
 * Lo que anuncia el aviso de la web: «20% de descuento» (promoción en todas las
 * cuotas), «… los 3 primeros meses» (promoción con duración) o «… en tu primer
 * pago» (cupón).
 */
export function promoOfferText(promo: PublicActivePromotionDto, t: PromoT): string {
  const base =
    promo.discountType === 'percentage'
      ? t('percentageOff', { value: promo.discountValue })
      : promo.discountType === 'fixed'
        ? t('fixedOff', { value: `${promo.discountValue} €` })
        : t('freeMonths', { count: promo.discountValue });
  if (promo.kind === 'coupon') {
    const min = promo.minMonths ?? 1;
    return `${base} ${min > 1 ? t('firstPaymentMonths', { count: min }) : t('firstPayment')}`;
  }
  if (promo.durationMonths) return `${base} ${t('firstMonths', { count: promo.durationMonths })}`;
  return base;
}

/** Meses que hay que pagar por adelantado para que valga el cupón (3, 6 o 12). */
export function promoBookMonths(promo: PublicActivePromotionDto): number | undefined {
  const min = promo.kind === 'coupon' ? (promo.minMonths ?? 1) : 1;
  return min > 1 ? [3, 6, 12].find((m) => m >= min) : undefined;
}
