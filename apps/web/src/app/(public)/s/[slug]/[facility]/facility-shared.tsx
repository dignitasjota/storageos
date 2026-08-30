import { toEmbedVideoUrl } from '@storageos/shared';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider, useTranslations } from 'next-intl';

import { trackEvent } from '../google-analytics';
import {
  bookHref,
  getPublicWebMessages,
  intlLocaleFor,
  type PublicWebLocale,
} from '../i18n/messages';
import { siteUrl } from '../landing-shared';
import { FacilityMeta, priceRangeString, UnitTypeList } from '../templates';
import { TenantWebChrome } from '../tenant-web-chrome';

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

/** Vídeo del local: embebido si es un formato reconocido (YouTube/Vimeo), si no un enlace de respaldo. */
function FacilityVideo({ url, title }: { url: string; title: string }) {
  const embed = toEmbedVideoUrl(url);
  if (embed) {
    return (
      <iframe
        src={embed}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="mt-6 aspect-video w-full rounded-md border"
        title={title}
      />
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-6 inline-block text-sm text-primary underline"
    >
      {title}
    </a>
  );
}

function FacilityHeading({ f }: { f: PublicFacilityLandingDto['facility'] }) {
  const t = useTranslations('publicWeb.facility');
  return (
    <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
      {f.city
        ? t('headingWithCity', { city: f.city, name: f.name })
        : t('headingDefault', { name: f.name })}
    </h1>
  );
}

function FacilityBody({
  data,
  slug,
  facilitySlug,
  locale,
}: {
  data: PublicFacilityLandingDto;
  slug: string;
  facilitySlug: string;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb');
  const f = data.facility;
  const jsonLd = buildFacilityJsonLd(data, slug, facilitySlug, locale);

  return (
    <TenantWebChrome
      data={data}
      locale={locale}
      facilitySlug={facilitySlug}
      hasBlog={data.hasBlog}
      googleAnalyticsId={data.googleAnalyticsId}
    >
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />

        {data.logoUrl && (
          <Image
            src={data.logoUrl}
            alt={data.tenantName}
            width={170}
            height={48}
            className="mb-6 h-12 w-auto object-contain"
          />
        )}

        <nav className="mb-4 text-sm text-muted-foreground">
          <Link href={`/s/${data.tenantSlug}`} className="hover:text-foreground">
            {data.tenantName}
          </Link>
          <span className="mx-1.5">/</span>
          <span>{f.name}</span>
        </nav>

        <FacilityHeading f={f} />

        <FacilityMeta f={f} tenantName={data.tenantName} />

        {f.imageUrls.length > 0 && (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {f.imageUrls.map((url, index) => (
              <div
                key={url}
                className="relative aspect-video w-full overflow-hidden rounded-md border"
              >
                <Image
                  src={url}
                  alt={t('facility.photoAlt', { index: index + 1, name: f.name })}
                  fill
                  loading="lazy"
                  sizes="(min-width: 640px) 33vw, 50vw"
                  className="object-cover"
                />
              </div>
            ))}
          </div>
        )}

        {f.videoUrl && <FacilityVideo url={f.videoUrl} title={t('facility.video')} />}

        <Link
          href={bookHref(data.tenantSlug, locale, { facilityId: f.id })}
          onClick={() => trackEvent('cta_reservar_click', { location: 'facility_page' })}
          className="mt-6 inline-flex h-11 items-center rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
          style={{ backgroundColor: data.brandColor ?? 'hsl(var(--primary))' }}
        >
          {t('common.reserveNow')}
        </Link>

        <h2 className="mt-10 text-xl font-semibold">{t('facility.sizesAndPrices')}</h2>
        <UnitTypeList f={f} locale={locale} />
      </div>
    </TenantWebChrome>
  );
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
      <FacilityBody data={data} slug={slug} facilitySlug={facilitySlug} locale={locale} />
    </NextIntlClientProvider>
  );
}
