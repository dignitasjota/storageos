'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { PUBLIC_WEB_LOCALE_SEGMENT, type PublicWebLocale } from './messages';

const LOCALE_LABEL: Record<PublicWebLocale, string> = { es: 'ES', en: 'EN' };

/**
 * Construye la URL de la otra versión de idioma para el mismo local/landing.
 * Si el tenant tiene un dominio propio verificado, usa la forma corta bajo
 * ese dominio (`https://<dominio>[/l/en][/<local>]`) en vez de `/s/<slug>`.
 */
function hrefFor(
  locale: PublicWebLocale,
  tenantSlug: string,
  facilitySlug?: string,
  customDomain?: string | null,
): string {
  const suffix = facilitySlug ? `/${facilitySlug}` : '';
  if (customDomain) {
    const base = `https://${customDomain}`;
    if (locale === 'es') return `${base}${suffix}`;
    return `${base}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}${suffix}`;
  }
  const base = `/s/${tenantSlug}`;
  if (locale === 'es') return `${base}${suffix}`;
  return `${base}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}${suffix}`;
}

/**
 * Selector ES/EN de la web pública del tenant. Enlaza a la MISMA página en
 * el otro idioma (no solo a la home), para no perder el contexto del
 * visitante (ficha de local → sigue en la ficha de local, solo cambia el
 * idioma). `otherLocaleHref` permite reutilizarlo fuera de `/s/[slug]`
 * (reserva, firma) con la URL YA RESUELTA de esa ruta (`bookHref`/`signHref`)
 * — recibe el string, no la función que lo genera: este componente es
 * cliente y `TenantWebChrome` (su padre) es Server Component, así que una
 * función no podría cruzar esa frontera (no es serializable).
 */
export function LanguageSwitcher({
  tenantSlug,
  facilitySlug,
  currentLocale,
  otherLocaleHref,
  customDomain,
}: {
  tenantSlug: string;
  facilitySlug?: string;
  currentLocale: PublicWebLocale;
  otherLocaleHref?: string;
  customDomain?: string | null;
}) {
  const t = useTranslations('publicWeb.languageSwitcher');
  const other: PublicWebLocale = currentLocale === 'es' ? 'en' : 'es';
  return (
    <Link
      href={otherLocaleHref ?? hrefFor(other, tenantSlug, facilitySlug, customDomain)}
      className="inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      aria-label={t('label')}
    >
      {LOCALE_LABEL[other]}
    </Link>
  );
}
