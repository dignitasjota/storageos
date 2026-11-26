import { z } from 'zod';

import { normalizeSeoUrl, splitSeoUrl } from './diagnostics';

/**
 * SEO Avanzado, PR 8 (§18.9): lo que trae el tráfico orgánico de Google.
 *
 * Una conversión cuenta si llega con origen Google orgánico (lo que guarda la
 * atribución de la web: `utm_source=google` con `utm_medium=organic`, o sin
 * medio, que es lo que da un clic en un resultado de Google). Se reparte por
 * la página de entrada (la primera página que vio el visitante, si se sabe);
 * por búsqueda solo se puede estimar (Google no dice qué búsqueda trajo a
 * quién), repartiendo cada página entre las búsquedas que llevan a ella en
 * proporción a sus clics.
 */

export const SEO_CONVERSION_TYPES = [
  'booking_started',
  'booking_signed',
  'booking_paid',
  'contact',
  'waitlist',
  'demo_request',
  'signup',
  'paid_signup',
] as const;
export type SeoConversionType = (typeof SEO_CONVERSION_TYPES)[number];

export const SEO_CONVERSION_TYPE_LABELS: Record<SeoConversionType, string> = {
  booking_started: 'Reservas online',
  booking_signed: 'Reservas firmadas',
  booking_paid: 'Reservas pagadas',
  contact: 'Contactos de la web',
  waitlist: 'Lista de espera',
  demo_request: 'Solicitudes de demo y contacto',
  signup: 'Altas de prueba',
  paid_signup: 'Altas que pagan',
};

/** Lo que cuenta en la web de un negocio. */
export const SEO_TENANT_CONVERSION_TYPES: SeoConversionType[] = [
  'booking_started',
  'booking_signed',
  'booking_paid',
  'contact',
  'waitlist',
];
/** Lo que cuenta en la web de la plataforma (trasteros.pro). */
export const SEO_PLATFORM_CONVERSION_TYPES: SeoConversionType[] = [
  'demo_request',
  'signup',
  'paid_signup',
];

/**
 * Las que entran en la tasa de conversión: el primer paso de cada camino (la
 * firma y el pago son pasos de la misma reserva y no se suman otra vez).
 */
export const SEO_PRIMARY_CONVERSION_TYPES: SeoConversionType[] = [
  'booking_started',
  'contact',
  'waitlist',
  'demo_request',
  'signup',
];

/** Origen Google orgánico (no anuncios: un clic en un anuncio llega como `cpc`). */
export function isOrganicGoogleSource(
  source: string | null | undefined,
  medium: string | null | undefined,
): boolean {
  if (!source || source.trim().toLowerCase() !== 'google') return false;
  const m = medium?.trim().toLowerCase() ?? '';
  return m === '' || m === 'organic';
}

/** Días que se recalculan cada noche (Google y los pagos llegan con retraso). */
export const SEO_CONVERSIONS_DAILY_DAYS = 7;
/** Días que recalcula «Recalcular». */
export const SEO_CONVERSIONS_RECALC_DAYS = 90;
/** Páginas que se enseñan en la tabla. */
export const SEO_CONVERSION_PAGES_MAX = 50;
/** Búsquedas estimadas que se enseñan. */
export const SEO_CONVERSION_QUERIES_MAX = 20;

/**
 * Clave de la página de entrada para cruzarla con las páginas de Search
 * Console: la ruta (sin dominio, parámetros ni barra final) en minúsculas.
 * La web de un negocio en la dirección de la plataforma (`/s/<negocio>/…`)
 * cuenta como su propia ruta. Vacío = no se sabe.
 */
export function seoLandingKey(raw: string | null | undefined): string {
  const s = raw?.trim();
  if (!s) return '';
  const normalized = normalizeSeoUrl(s.startsWith('/') ? s : /^[a-z]+:\/\//i.test(s) ? s : `/${s}`);
  const slash = normalized.indexOf('/');
  let path = slash >= 0 ? normalized.slice(slash) : '/';
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  path = path.replace(/^\/s\/[^/]+(?=\/|$)/, '') || '/';
  return path.slice(0, 300);
}

/** Clave de una página de Search Console (URL completa) para cruzarla con la de entrada. */
export function seoPageLandingKey(page: string): string {
  return seoLandingKey(splitSeoUrl(page).path);
}

/** Conversiones ÷ clics (null sin clics). */
export function seoConversionRate(conversions: number, clicks: number): number | null {
  return clicks > 0 ? Math.round((conversions / clicks) * 10_000) / 10_000 : null;
}

export interface SeoQueryPageClicks {
  query: string;
  /** Clave de la página (`seoPageLandingKey`). */
  pageKey: string;
  clicks: number;
}

export interface SeoEstimatedQueryConversion {
  query: string;
  /** Estimación (con decimales): se enseña redondeada y marcada como tal. */
  conversions: number;
  /** Clics de la búsqueda en las páginas que convierten. */
  clicks: number;
  /** Páginas de entrada de las que sale la estimación. */
  pages: string[];
}

/**
 * Reparto estimado de las conversiones de cada página de entrada entre las
 * búsquedas que llevan a ella, en proporción a sus clics (cruce búsqueda +
 * página). Una página sin clics por búsqueda no se reparte (lo que se pierde
 * es la parte que Google no detalla).
 */
export function estimateSeoConversionsByQuery(
  pages: readonly { landingKey: string; conversions: number }[],
  queryPages: readonly SeoQueryPageClicks[],
  max = SEO_CONVERSION_QUERIES_MAX,
): SeoEstimatedQueryConversion[] {
  const byPage = new Map<string, SeoQueryPageClicks[]>();
  for (const r of queryPages) {
    if (r.clicks <= 0) continue;
    const list = byPage.get(r.pageKey) ?? [];
    list.push(r);
    byPage.set(r.pageKey, list);
  }
  const out = new Map<string, SeoEstimatedQueryConversion>();
  for (const p of pages) {
    if (!p.landingKey || p.conversions <= 0) continue;
    const rows = byPage.get(p.landingKey);
    if (!rows?.length) continue;
    const total = rows.reduce((s, r) => s + r.clicks, 0);
    for (const r of rows) {
      const share = (p.conversions * r.clicks) / total;
      const cur = out.get(r.query) ?? { query: r.query, conversions: 0, clicks: 0, pages: [] };
      cur.conversions += share;
      cur.clicks += r.clicks;
      if (!cur.pages.includes(p.landingKey)) cur.pages.push(p.landingKey);
      out.set(r.query, cur);
    }
  }
  return [...out.values()]
    .map((r) => ({ ...r, conversions: Math.round(r.conversions * 100) / 100 }))
    .filter((r) => r.conversions > 0)
    .sort(
      (a, b) =>
        b.conversions - a.conversions || b.clicks - a.clicks || a.query.localeCompare(b.query),
    )
    .slice(0, max);
}

// ------------------------------------------------------------------- DTOs

export interface SeoConversionTypeTotalDto {
  type: SeoConversionType;
  count: number;
  /** null si el periodo anterior no se compara. */
  previous: number | null;
  /** Ingresos del primer pago (solo en los pagos). */
  revenue: number | null;
}

export interface SeoConversionPageDto {
  /** Ruta de entrada (`/precios`); vacío = no se sabe. */
  landing: string;
  clicks: number;
  conversions: number;
  rate: number | null;
  byType: Partial<Record<SeoConversionType, number>>;
}

export interface SeoConversionsDto {
  /** `tenant`, `platform` o null (proyecto de la plataforma que no es trasteros.pro). */
  scope: 'tenant' | 'platform' | null;
  /** Proyecto de la plataforma: lo marcado a mano (null = por el dominio). */
  platformConversions: boolean | null;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  /** El periodo tiene datos de Google de casi todos sus días (si no, sin tasa). */
  complete: boolean;
  /** El anterior también (si no, sin comparación). */
  comparable: boolean;
  types: SeoConversionTypeTotalDto[];
  /** Conversiones principales (`SEO_PRIMARY_CONVERSION_TYPES`), clics y tasa. */
  primary: {
    count: number;
    previous: number | null;
    clicks: number;
    previousClicks: number | null;
    rate: number | null;
    previousRate: number | null;
  };
  revenue: number | null;
  pages: SeoConversionPageDto[];
  /** Estimación: el reparto de las páginas entre las búsquedas que llevan a ellas. */
  queries: SeoEstimatedQueryConversion[];
  calculatedAt: string | null;
}

/** Proyecto de la plataforma: si cuenta las conversiones de trasteros.pro (null = por el dominio). */
export const UpdateSeoConversionSettingsSchema = z.object({
  platformConversions: z.boolean().nullable(),
});
export type UpdateSeoConversionSettingsInput = z.infer<typeof UpdateSeoConversionSettingsSchema>;
