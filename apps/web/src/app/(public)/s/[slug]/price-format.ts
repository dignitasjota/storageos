import { intlLocaleFor, type PublicWebLocale } from './i18n/messages';

/**
 * Funciones PURAS de formato de precio, sin `'use client'` — las necesitan
 * tanto los constructores de JSON-LD (Server Components: `landing-shared.tsx`,
 * `[facility]/facility-shared.tsx`) como las plantillas de render (Client
 * Components). Una función exportada de un fichero `'use client'` no se puede
 * invocar directamente desde un Server Component (solo renderizar como JSX),
 * así que estas dos viven aparte.
 */
/**
 * Precio mensual con IVA de un tamaño: 21 % o el que diga la API (0 % en
 * viviendas, exentas). Sin `taxRate` (API anterior), 21 %.
 */
export function grossPrice(t: { priceMonthly: number; taxRate?: number }): number {
  return t.priceMonthly * (1 + (t.taxRate ?? 21) / 100);
}

export function formatPrice(n: number, locale: PublicWebLocale): string {
  return n.toLocaleString(intlLocaleFor(locale), {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
}

/**
 * Rango de precio (IVA incl.) para la propiedad `priceRange` del JSON-LD
 * `LocalBusiness`/`SelfStorage` — ayuda a Google a mostrar el nivel de precio
 * en resultados/Maps. `null` si no hay tipos de trastero.
 */
export function priceRangeString(
  unitTypes: { priceMonthly: number; taxRate?: number }[],
  locale: PublicWebLocale,
): string | null {
  if (unitTypes.length === 0) return null;
  const prices = unitTypes.map(grossPrice);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max
    ? formatPrice(min, locale)
    : `${formatPrice(min, locale)}–${formatPrice(max, locale)}`;
}
