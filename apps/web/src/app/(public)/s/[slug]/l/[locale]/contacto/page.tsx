import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { redirectToDefaultLocale } from '../../../i18n/default-locale-redirect';
import { DEFAULT_PUBLIC_WEB_LOCALE, isPublicWebLocale } from '../../../i18n/messages';
import { buildLandingMetadata, LandingPageBody } from '../../../landing-shared';

import type { Metadata } from 'next';

type Params = { params: Promise<{ slug: string; locale: string }> };

/** `/l/<idioma>/contacto` del dominio propio (la misma web bajando a la sección). */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, locale } = await params;
  if (!isPublicWebLocale(locale)) return { robots: { index: false } };
  return buildLandingMetadata(slug, locale, 'contacto');
}

export default async function Page({ params }: Params) {
  const { slug, locale } = await params;
  if (!isPublicWebLocale(locale)) notFound();
  if ((await headers()).get('x-storageos-tenant-slug') !== slug) notFound();
  if (locale === DEFAULT_PUBLIC_WEB_LOCALE) await redirectToDefaultLocale(slug, '/contacto');
  return <LandingPageBody slug={slug} locale={locale} section="contacto" />;
}
