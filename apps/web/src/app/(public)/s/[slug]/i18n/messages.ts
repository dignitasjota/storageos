import type { AbstractIntlMessages } from 'next-intl';

/**
 * i18n de la web pública del tenant — AISLADO del `next-intl` global de la
 * app (`src/lib/i18n/request.ts`, fijo a `es-ES` para panel/portal). Aquí el
 * locale lo elige el VISITANTE anónimo vía la URL (`/s/[slug]` = español,
 * `/s/[slug]/l/[locale]` = otros idiomas — ver `[locale]/page.tsx`), no hay
 * sesión ni cookie de por medio.
 *
 * Alcance: solo se traduce el CHROME estático (botones, etiquetas,
 * cabeceras). El contenido que escribe el propio tenant (webHeadline,
 * webAbout, testimonios, preguntas/respuestas de FAQ, nombres/direcciones de
 * local) es texto libre en español y NO se traduce automáticamente — no hay
 * forma fiable de hacerlo sin una API de traducción de pago.
 */
export type PublicWebLocale = 'es' | 'en';
export const PUBLIC_WEB_LOCALES: PublicWebLocale[] = ['es', 'en'];
export const DEFAULT_PUBLIC_WEB_LOCALE: PublicWebLocale = 'es';

/** Segmento reservado para las rutas de idioma (`/s/[slug]/l/[locale]`). */
export const PUBLIC_WEB_LOCALE_SEGMENT = 'l';

export function isPublicWebLocale(value: string): value is PublicWebLocale {
  return (PUBLIC_WEB_LOCALES as string[]).includes(value);
}

/** Locale de `Intl`/`toLocaleString` para formatear precios según el idioma (la moneda sigue siendo EUR). */
export function intlLocaleFor(locale: PublicWebLocale): string {
  return locale === 'en' ? 'en-GB' : 'es-ES';
}

export async function getPublicWebMessages(locale: PublicWebLocale): Promise<AbstractIntlMessages> {
  const messages = locale === 'en' ? await import('./en.json') : await import('./es.json');
  return messages.default as unknown as AbstractIntlMessages;
}

/**
 * URL del flujo de reserva de un tenant, respetando el idioma actual del
 * visitante — español (por defecto) va a la ruta desnuda `/book/[slug]`, el
 * resto de idiomas al segmento reservado `/book/[slug]/l/[locale]` (mismo
 * patrón que `/s/[slug]/l/[locale]`).
 *
 * Con dominio propio verificado (`customDomain`), la reserva vive en ese
 * dominio con una dirección sin el tenant: `https://<dominio>/reservar` o, con
 * un local elegido, `https://<dominio>/reservar/<publicSlug>` (+ `/l/<idioma>`).
 * Es absoluta para que funcione también desde `trasteros.pro/s/<slug>`.
 *
 * `params.facilityId`/`unitTypeId` (opcionales) preseleccionan la elección
 * que el visitante ya hizo en la calculadora, la ficha de un local o el
 * listado — evita que tenga que repetirla en el formulario de reserva. En el
 * dominio propio el local va en la ruta (`facilitySlug`) y solo si no tiene
 * slug público se pasa por `facilityId`.
 */
export function bookHref(
  tenantSlug: string,
  locale: PublicWebLocale,
  params?: {
    facilityId?: string;
    facilitySlug?: string | null;
    unitTypeId?: string;
    waitlist?: boolean;
    /** Cupón ya aplicado y meses del primer pago (landings de promoción). */
    coupon?: string;
    months?: number;
    /** Variables de seguimiento que llegan a la reserva (`utm_source`…). */
    utm?: Record<string, string>;
  },
  customDomain?: string | null,
): string {
  const localeSuffix =
    locale === DEFAULT_PUBLIC_WEB_LOCALE ? '' : `/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}`;
  const qs = new URLSearchParams();
  let base: string;
  if (customDomain) {
    const centro = params?.facilityId && params.facilitySlug ? params.facilitySlug : null;
    base = `https://${customDomain}/reservar${centro ? `/${encodeURIComponent(centro)}` : ''}${localeSuffix}`;
    if (params?.facilityId && !centro) qs.set('facilityId', params.facilityId);
  } else {
    base = `/book/${encodeURIComponent(tenantSlug)}${localeSuffix}`;
    if (params?.facilityId) qs.set('facilityId', params.facilityId);
  }
  if (params?.facilityId && params.unitTypeId) qs.set('unitTypeId', params.unitTypeId);
  // Tipo agotado: abre la lista de espera de la reserva con esa elección.
  if (params?.facilityId && params.waitlist) {
    qs.set('waitlist', '1');
    return `${base}?${qs.toString()}#waitlist`;
  }
  if (params?.coupon) qs.set('coupon', params.coupon);
  if (params?.months && params.months > 1) qs.set('months', String(params.months));
  for (const [k, v] of Object.entries(params?.utm ?? {})) qs.set(k, v);
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}

/** Lo mínimo de la web del tenant que necesita `bookHrefFor`. */
export interface BookSite {
  tenantSlug: string;
  customDomain: string | null;
  facilities: { id: string; publicSlug: string | null }[];
}

/**
 * `bookHref` con el dominio propio y el slug público del local sacados de los
 * datos de la web: en el dominio propio da `/reservar/<centro>`.
 */
export function bookHrefFor(
  site: BookSite,
  locale: PublicWebLocale,
  params?: {
    facilityId?: string;
    unitTypeId?: string;
    waitlist?: boolean;
    coupon?: string;
    months?: number;
    utm?: Record<string, string>;
  },
): string {
  const facilitySlug = params?.facilityId
    ? (site.facilities.find((f) => f.id === params.facilityId)?.publicSlug ?? null)
    : null;
  return bookHref(site.tenantSlug, locale, { ...params, facilitySlug }, site.customDomain);
}

/**
 * URL de la página de firma de un contrato, respetando el idioma actual del
 * visitante — mismo patrón que `bookHref`.
 */
export function signHref(token: string, locale: PublicWebLocale): string {
  const encoded = encodeURIComponent(token);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/sign/${encoded}`
    : `/sign/${encoded}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}`;
}

/**
 * URL de la home (landing) del tenant, respetando el idioma actual y, si
 * tiene un dominio propio VERIFICADO (`resolveCustomDomainRoute` ya sabe
 * reescribir sus rutas de 1 segmento), la forma corta bajo ese dominio en
 * vez de `/s/<slug>`.
 */
export function landingHref(
  tenantSlug: string,
  locale: PublicWebLocale,
  customDomain?: string | null,
): string {
  if (customDomain) {
    return locale === DEFAULT_PUBLIC_WEB_LOCALE
      ? `https://${customDomain}`
      : `https://${customDomain}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}`;
  }
  const encoded = encodeURIComponent(tenantSlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/s/${encoded}`
    : `/s/${encoded}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}`;
}

/** URL del listado del blog del tenant, respetando el idioma actual y el dominio propio (ver `landingHref`). */
export function blogHref(
  tenantSlug: string,
  locale: PublicWebLocale,
  customDomain?: string | null,
): string {
  if (customDomain) {
    return locale === DEFAULT_PUBLIC_WEB_LOCALE
      ? `https://${customDomain}/blog`
      : `https://${customDomain}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/blog`;
  }
  const encoded = encodeURIComponent(tenantSlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/s/${encoded}/blog`
    : `/s/${encoded}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/blog`;
}

/** URL de una entrada del blog del tenant, respetando el idioma actual y el dominio propio (ver `landingHref`). */
export function blogPostHref(
  tenantSlug: string,
  postSlug: string,
  locale: PublicWebLocale,
  customDomain?: string | null,
): string {
  const encodedPost = encodeURIComponent(postSlug);
  if (customDomain) {
    return locale === DEFAULT_PUBLIC_WEB_LOCALE
      ? `https://${customDomain}/blog/${encodedPost}`
      : `https://${customDomain}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/blog/${encodedPost}`;
  }
  const encodedTenant = encodeURIComponent(tenantSlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/s/${encodedTenant}/blog/${encodedPost}`
    : `/s/${encodedTenant}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/blog/${encodedPost}`;
}

/**
 * URL de la ficha pública de un local del tenant, respetando el idioma
 * actual y, si tiene un dominio propio verificado, la forma corta
 * `https://<dominio>/<local>` en vez de `/s/<slug>/<local>` — el middleware
 * (`resolveCustomDomainRoute`) ya reescribe internamente esa ruta de 1
 * segmento hacia `/s/<slug>/<local>`, así que enlazar directamente a la
 * forma corta es válido y evita que se vea/comparta la URL larga.
 */
export function facilityHref(
  tenantSlug: string,
  facilitySlug: string,
  locale: PublicWebLocale,
  customDomain?: string | null,
): string {
  const encodedFacility = encodeURIComponent(facilitySlug);
  if (customDomain) {
    return locale === DEFAULT_PUBLIC_WEB_LOCALE
      ? `https://${customDomain}/${encodedFacility}`
      : `https://${customDomain}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/${encodedFacility}`;
  }
  const encodedTenant = encodeURIComponent(tenantSlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/s/${encodedTenant}/${encodedFacility}`
    : `/s/${encodedTenant}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/${encodedFacility}`;
}

/** Página legal de la web del tenant (aviso legal, privacidad, cookies). */
export function legalHref(
  tenantSlug: string,
  doc: 'aviso-legal' | 'privacidad' | 'cookies',
  customDomain?: string | null,
): string {
  return customDomain
    ? `https://${customDomain}/${doc}`
    : `/s/${encodeURIComponent(tenantSlug)}/${doc}`;
}

/** Página de una ciudad (`/trasteros-en-<ciudad>`), con el idioma y el dominio propio. */
export function cityPageHref(
  tenantSlug: string,
  citySlug: string,
  locale: PublicWebLocale,
  customDomain?: string | null,
): string {
  return facilityHref(tenantSlug, `trasteros-en-${citySlug}`, locale, customDomain);
}
