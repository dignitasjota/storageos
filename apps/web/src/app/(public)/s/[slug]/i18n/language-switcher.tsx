'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { PUBLIC_WEB_LOCALE_SEGMENT, type PublicWebLocale } from './messages';

const LOCALE_LABEL: Record<PublicWebLocale, string> = { es: 'ES', en: 'EN' };

/** Construye la URL de la otra versión de idioma para el mismo local/landing. */
function hrefFor(locale: PublicWebLocale, tenantSlug: string, facilitySlug?: string): string {
  const base = `/s/${tenantSlug}`;
  const suffix = facilitySlug ? `/${facilitySlug}` : '';
  if (locale === 'es') return `${base}${suffix}`;
  return `${base}/${PUBLIC_WEB_LOCALE_SEGMENT}/${locale}${suffix}`;
}

/**
 * Selector ES/EN de la web pública del tenant. Enlaza a la MISMA página en
 * el otro idioma (no solo a la home), para no perder el contexto del
 * visitante (ficha de local → sigue en la ficha de local, solo cambia el
 * idioma).
 */
export function LanguageSwitcher({
  tenantSlug,
  facilitySlug,
  currentLocale,
}: {
  tenantSlug: string;
  facilitySlug?: string;
  currentLocale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.languageSwitcher');
  const other: PublicWebLocale = currentLocale === 'es' ? 'en' : 'es';
  return (
    <Link
      href={hrefFor(other, tenantSlug, facilitySlug)}
      className="inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      aria-label={t('label')}
    >
      {LOCALE_LABEL[other]}
    </Link>
  );
}
