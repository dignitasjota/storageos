import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { getPublicWebMessages, intlLocaleFor, type PublicWebLocale } from '../i18n/messages';
import { siteUrl } from '../landing-shared';
import { priceRangeString } from '../price-format';
import { TenantWebChrome } from '../tenant-web-chrome';

import { FacilityBody } from './facility-body';

import type { PublicFacilityLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function getFacility(
  slug: string,
  facility: string,
): Promise<PublicFacilityLandingDto | null> {
  try {
    const res = await fetch(
      `${API_URL}/public/landing/${encodeURIComponent(slug)}/${encodeURIComponent(facility)}`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicFacilityLandingDto;
  } catch {
    return null;
  }
}

/**
 * Datos estructurados de la ficha de local: `Organization`+`WebSite`, el
 * `SelfStorage` (con imágenes) y `BreadcrumbList` (coherente con el
 * breadcrumb visual ya renderizado en la página). Sin `AggregateRating`/
 * `FAQPage` aquí — `PublicFacilityLandingDto` no trae testimonios/FAQ (son
 * tenant-wide, no por local); si se quiere en el futuro, la landing del
 * tenant (`/s/[slug]`) ya los emite.
 */
export function buildFacilityJsonLd(
  data: PublicFacilityLandingDto,
  slug: string,
  facilitySlug: string,
  locale: PublicWebLocale,
) {
  const tenantBase = data.customDomain ? `https://${data.customDomain}` : `${siteUrl()}/s/${slug}`;
  const orgId = `${tenantBase}/#organization`;
  const pageUrl = data.customDomain
    ? `https://${data.customDomain}/${facilitySlug}`
    : `${tenantBase}/${facilitySlug}`;
  const f = data.facility;

  const organization = {
    '@type': 'Organization',
    '@id': orgId,
    name: data.tenantName,
    url: tenantBase,
    ...(data.logoUrl ? { logo: data.logoUrl } : {}),
  };

  const website = {
    '@type': 'WebSite',
    '@id': `${tenantBase}/#website`,
    url: tenantBase,
    name: data.tenantName,
    publisher: { '@id': orgId },
    inLanguage: intlLocaleFor(locale),
  };

  const priceRange = priceRangeString(f.unitTypes, locale);
  const selfStorage = {
    '@type': 'SelfStorage',
    '@id': `${pageUrl}#local`,
    name: `${data.tenantName} — ${f.name}`,
    parentOrganization: { '@id': orgId },
    ...(f.imageUrls.length > 0 ? { image: f.imageUrls } : {}),
    ...(f.address || f.city
      ? {
          address: {
            '@type': 'PostalAddress',
            ...(f.address ? { streetAddress: f.address } : {}),
            ...(f.city ? { addressLocality: f.city } : {}),
            ...(f.postalCode ? { postalCode: f.postalCode } : {}),
            addressCountry: 'ES',
          },
        }
      : {}),
    ...(f.contactPhone ? { telephone: f.contactPhone } : {}),
    ...(f.contactEmail ? { email: f.contactEmail } : {}),
    ...(priceRange ? { priceRange } : {}),
  };

  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: data.tenantName, item: tenantBase },
      { '@type': 'ListItem', position: 2, name: f.name, item: pageUrl },
    ],
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, selfStorage, breadcrumb],
  };
}

/** `hreflang` alternates es/en + x-default, absolutos si hay dominio propio. */
function languageAlternates(
  data: Pick<PublicFacilityLandingDto, 'customDomain'>,
  slug: string,
  facilitySlug: string,
): Record<string, string> {
  const base = data.customDomain
    ? `https://${data.customDomain}/${facilitySlug}`
    : `/s/${slug}/${facilitySlug}`;
  return {
    es: base,
    en: data.customDomain
      ? `https://${data.customDomain}/l/en/${facilitySlug}`
      : `/s/${slug}/l/en/${facilitySlug}`,
    'x-default': base,
  };
}

export async function buildFacilityMetadata(
  slug: string,
  facilitySlug: string,
  locale: PublicWebLocale,
): Promise<Metadata> {
  const data = await getFacility(slug, facilitySlug);
  if (!data) {
    return {
      title: locale === 'en' ? 'Not found' : 'No encontrado',
      robots: { index: false },
    };
  }
  const f = data.facility;
  const title =
    locale === 'en'
      ? `Storage units${f.city ? ` in ${f.city}` : ''} — ${f.name} · ${data.tenantName}`
      : `Trasteros${f.city ? ` en ${f.city}` : ''} — ${f.name} · ${data.tenantName}`;
  const description =
    locale === 'en'
      ? `Rent a storage unit at ${f.name}${f.city ? ` (${f.city})` : ''}. Check sizes, prices and availability and book online.`
      : `Alquila un trastero en ${f.name}${
          f.city ? ` (${f.city})` : ''
        }. Consulta tamaños, precios y disponibilidad y reserva online.`;
  const base = data.customDomain
    ? `https://${data.customDomain}/${facilitySlug}`
    : `/s/${slug}/${facilitySlug}`;
  const canonical =
    locale === 'en'
      ? data.customDomain
        ? `https://${data.customDomain}/l/en/${facilitySlug}`
        : `/s/${slug}/l/en/${facilitySlug}`
      : base;
  return {
    title,
    description,
    alternates: { canonical, languages: languageAlternates(data, slug, facilitySlug) },
    robots: { index: true, follow: true },
    // Sin `opengraph-image.tsx` propio para este segmento: hereda el del
    // tenant en `/s/[slug]/opengraph-image.tsx` (convención de Next).
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: data.tenantName,
      locale: locale === 'en' ? 'en_GB' : 'es_ES',
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/**
 * Cuerpo de la ficha de local, parametrizado por `locale` — lo comparten la
 * ruta por defecto (`/s/[slug]/[facility]`, español) y la ruta con segmento
 * de idioma (`/s/[slug]/l/[locale]/[facility]`).
 */
export async function FacilityPageBody({
  slug,
  facilitySlug,
  locale,
}: {
  slug: string;
  facilitySlug: string;
  locale: PublicWebLocale;
}) {
  const data = await getFacility(slug, facilitySlug);
  if (!data) notFound();
  const messages = await getPublicWebMessages(locale);

  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <TenantWebChrome
        data={data}
        locale={locale}
        facilitySlug={facilitySlug}
        hasBlog={data.hasBlog}
        googleAnalyticsId={data.googleAnalyticsId}
      >
        <FacilityBody data={data} slug={slug} facilitySlug={facilitySlug} locale={locale} />
      </TenantWebChrome>
    </NextIntlClientProvider>
  );
}
