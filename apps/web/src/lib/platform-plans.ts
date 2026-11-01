import type { SubscriptionPlanDto } from '@storageos/shared';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

/** Tarjeta de un plan en la portada (textos en `landing.pricing.plans`). */
export interface LandingPlanCopy {
  /** Slug del plan del catálogo con el que se cruzan precio y anualidad. */
  slug?: string;
  name: string;
  price: string;
  yearly?: number;
  tagline: string;
  cta: string;
  highlight?: boolean;
  features: string[];
}

export interface LandingPlan extends LandingPlanCopy {
  /** Precio mensual numérico (para los datos estructurados). */
  priceValue: number;
}

/**
 * Planes activos del catálogo (panel admin → Planes). `null` si la API no
 * responde: la portada usa entonces los precios de los textos.
 */
export async function fetchPublicPlans(): Promise<SubscriptionPlanDto[] | null> {
  try {
    const res = await fetch(`${SERVER_API_URL}/v1/subscription-plans`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as SubscriptionPlanDto[];
  } catch {
    return null;
  }
}

function formatPrice(n: number): string {
  return Number.isInteger(n)
    ? `${n}€`
    : `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€`;
}

/**
 * Cruza las tarjetas de la portada con el catálogo: el precio y la anualidad
 * salen del plan con ese slug y un plan desactivado deja de mostrarse. Sin
 * catálogo (API caída) se usan los precios de los textos.
 */
export function mergeLandingPlans(
  copy: LandingPlanCopy[],
  catalog: SubscriptionPlanDto[] | null,
): LandingPlan[] {
  const bySlug = new Map((catalog ?? []).map((p) => [p.slug, p]));
  const out: LandingPlan[] = [];
  for (const plan of copy) {
    const textPrice = Number.parseFloat(plan.price.replace(/[^\d.,]/g, '').replace(',', '.'));
    if (!catalog || !plan.slug) {
      out.push({ ...plan, priceValue: textPrice });
      continue;
    }
    const live = bySlug.get(plan.slug);
    if (!live) continue; // desactivado en el catálogo
    const merged: LandingPlan = {
      ...plan,
      price: formatPrice(live.priceMonthly),
      priceValue: live.priceMonthly,
    };
    if (live.priceYearly > 0) merged.yearly = live.priceYearly;
    else delete merged.yearly;
    out.push(merged);
  }
  return out;
}

/** Si los precios de la plataforma ya incluyen el IVA (por defecto, sí). */
export function catalogIncludesVat(catalog: SubscriptionPlanDto[] | null): boolean | null {
  const first = catalog?.[0];
  return first?.pricesIncludeVat ?? null;
}
