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
 */
export function bookHref(tenantSlug: string, locale: PublicWebLocale): string {
  const encoded = encodeURIComponent(tenantSlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/book/${encoded}`
    : `/book/${encoded}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}`;
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

/** URL del listado del blog del tenant, respetando el idioma actual. */
export function blogHref(tenantSlug: string, locale: PublicWebLocale): string {
  const encoded = encodeURIComponent(tenantSlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/s/${encoded}/blog`
    : `/s/${encoded}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/blog`;
}

/** URL de una entrada del blog del tenant, respetando el idioma actual. */
export function blogPostHref(
  tenantSlug: string,
  postSlug: string,
  locale: PublicWebLocale,
): string {
  const encodedTenant = encodeURIComponent(tenantSlug);
  const encodedPost = encodeURIComponent(postSlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/s/${encodedTenant}/blog/${encodedPost}`
    : `/s/${encodedTenant}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/blog/${encodedPost}`;
}

/** URL de la ficha pública de un local del tenant, respetando el idioma actual. */
export function facilityHref(
  tenantSlug: string,
  facilitySlug: string,
  locale: PublicWebLocale,
): string {
  const encodedTenant = encodeURIComponent(tenantSlug);
  const encodedFacility = encodeURIComponent(facilitySlug);
  return locale === DEFAULT_PUBLIC_WEB_LOCALE
    ? `/s/${encodedTenant}/${encodedFacility}`
    : `/s/${encodedTenant}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}/${encodedFacility}`;
}
