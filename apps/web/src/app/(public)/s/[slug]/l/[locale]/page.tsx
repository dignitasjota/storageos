import { notFound } from 'next/navigation';

import { redirectToDefaultLocale } from '../../i18n/default-locale-redirect';
import { DEFAULT_PUBLIC_WEB_LOCALE, isPublicWebLocale } from '../../i18n/messages';
import { buildLandingMetadata, LandingPageBody } from '../../landing-shared';

import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { slug, locale } = await params;
  if (!isPublicWebLocale(locale)) return { robots: { index: false } };
  return buildLandingMetadata(slug, locale);
}

export default async function LandingLocalePage({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}) {
  const { slug, locale } = await params;
  if (!isPublicWebLocale(locale)) notFound();
  // El idioma por defecto ya vive en la ruta desnuda `/s/[slug]` — evita
  // contenido duplicado indexable en `/l/es`.
  if (locale === DEFAULT_PUBLIC_WEB_LOCALE) await redirectToDefaultLocale(slug);
  return <LandingPageBody slug={slug} locale={locale} />;
}
