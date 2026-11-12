import { getTranslations } from 'next-intl/server';

import { PricingCards, type PricingPlanView } from '@/components/marketing/pricing-cards';
import {
  catalogIncludesVat,
  fetchPublicPlans,
  mergeLandingPlans,
  type LandingPlan,
  type LandingPlanCopy,
} from '@/lib/platform-plans';

/** Planes de la portada cruzados con el catálogo (precio y anualidad del panel admin → Planes). */
export async function loadLandingPlans(): Promise<{
  plans: LandingPlan[];
  includesVat: boolean | null;
}> {
  const t = await getTranslations('landing');
  const copy = t.raw('pricing.plans') as LandingPlanCopy[];
  const catalog = await fetchPublicPlans();
  return { plans: mergeLandingPlans(copy, catalog), includesVat: catalogIncludesVat(catalog) };
}

/** Tarjetas de precios con el cambio mensual / anual. */
export async function PricingSection() {
  const t = await getTranslations('landing');
  const { plans, includesVat } = await loadLandingPlans();
  const views: PricingPlanView[] = plans.map((p) => ({
    name: p.name,
    tagline: p.tagline,
    cta: p.cta,
    highlight: Boolean(p.highlight),
    features: p.features,
    monthly: p.priceValue,
    yearly: p.yearly ?? null,
  }));
  return (
    <PricingCards
      plans={views}
      vatNote={includesVat === false ? t('pricing.ivaNote') : t('pricing.ivaIncludedNote')}
      mostPopular={t('pricing.mostPopular')}
    />
  );
}
