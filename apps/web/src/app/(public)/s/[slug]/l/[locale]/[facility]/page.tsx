import { notFound, redirect } from 'next/navigation';

import { buildFacilityMetadata, FacilityPageBody } from '../../../[facility]/facility-shared';
import { DEFAULT_PUBLIC_WEB_LOCALE, isPublicWebLocale } from '../../../i18n/messages';

import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string; facility: string }>;
}): Promise<Metadata> {
  const { slug, locale, facility } = await params;
  if (!isPublicWebLocale(locale)) return { robots: { index: false } };
  return buildFacilityMetadata(slug, facility, locale);
}

export default async function FacilityLandingLocalePage({
  params,
}: {
  params: Promise<{ slug: string; locale: string; facility: string }>;
}) {
  const { slug, locale, facility } = await params;
  if (!isPublicWebLocale(locale)) notFound();
  // El idioma por defecto ya vive en la ruta desnuda `/s/[slug]/[facility]` —
  // evita contenido duplicado indexable en `/l/es/[facility]`.
  if (locale === DEFAULT_PUBLIC_WEB_LOCALE) redirect(`/s/${slug}/${facility}`);
  return <FacilityPageBody slug={slug} facilitySlug={facility} locale={locale} />;
}
