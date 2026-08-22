'use client';

import { useTranslations } from 'next-intl';

import { usePortalLocale } from './provider';

import type { PortalLocale } from './messages';

const LOCALE_LABEL: Record<PortalLocale, string> = { es: 'ES', en: 'EN' };

/** Selector ES/EN del portal del inquilino: alterna el idioma in-place. */
export function PortalLanguageSwitcher() {
  const t = useTranslations('portal.languageSwitcher');
  const { locale, setLocale } = usePortalLocale();
  const other: PortalLocale = locale === 'es' ? 'en' : 'es';
  return (
    <button
      type="button"
      onClick={() => setLocale(other)}
      className="inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      aria-label={t('label')}
    >
      {LOCALE_LABEL[other]}
    </button>
  );
}
