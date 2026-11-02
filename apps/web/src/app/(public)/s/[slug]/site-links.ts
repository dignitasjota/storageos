import { parseWebLink } from '@storageos/shared';

import {
  blogHref,
  blogPostHref,
  bookHref,
  facilityHref,
  landingHref,
  type PublicWebLocale,
} from './i18n/messages';

/** Sección de trasteros y precios de la portada de cada plantilla. */
export const PRICES_ANCHOR: Record<string, string> = {
  onepage: 'espacios',
  escaparate: 'centros',
  corporate: 'centros',
  onepagemovil: 'trasteros',
  trstrom: 'trasteros',
  cabe: 'trasteros',
};

export interface SiteLinkContext {
  tenantSlug: string;
  locale: PublicWebLocale;
  customDomain: string | null;
  webTemplate: string;
}

/**
 * Dirección real de un enlace `web:…` del blog en esta web (trasteros.pro o
 * el dominio propio). Lo que no es `web:` se devuelve tal cual; un `web:` mal
 * escrito, a la portada.
 */
export function resolveSiteHref(href: string, ctx: SiteLinkContext): string {
  if (!href.startsWith('web:')) return href;
  const { tenantSlug: slug, locale, customDomain } = ctx;
  const home = landingHref(slug, locale, customDomain);
  const link = parseWebLink(href);
  if (!link) return home;
  if (link.kind === 'section') {
    switch (link.section) {
      case 'precios':
        return `${home}#${PRICES_ANCHOR[ctx.webTemplate] ?? 'precios'}`;
      case 'reservar':
        return bookHref(slug, locale, undefined, customDomain);
      case 'contacto':
        return `${home}#contacto`;
      case 'calculadora':
        return `${home}#calculadora`;
      case 'blog':
        return blogHref(slug, locale, customDomain);
    }
  }
  switch (link.kind) {
    case 'local':
    case 'pagina':
      return facilityHref(slug, link.slug, locale, customDomain);
    case 'post':
      return blogPostHref(slug, link.slug, locale, customDomain);
    case 'promo':
      return customDomain
        ? `https://${customDomain}/promo/${link.slug}`
        : `/s/${encodeURIComponent(slug)}/promo/${link.slug}`;
  }
  return home;
}
