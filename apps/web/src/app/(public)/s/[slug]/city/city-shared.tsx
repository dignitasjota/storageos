import {
  cityFromPageSlug,
  cityPages,
  type CityPage,
  type PublicLandingDto,
} from '@storageos/shared';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import {
  cityPageHref,
  getPublicWebMessages,
  intlLocaleFor,
  type PublicWebLocale,
} from '../i18n/messages';
import { getLanding, siteUrl } from '../landing-shared';
import { formatPrice, grossPrice } from '../price-format';
import { TenantWebChrome } from '../tenant-web-chrome';
import { WhatsappFloatButton } from '../whatsapp-float-button';

import { CityBody } from './city-body';

import type { Metadata } from 'next';

import { safeJsonLd } from '@/lib/json-ld';

type Facility = PublicLandingDto['facilities'][number];

/** Datos de la página de una ciudad (`trasteros-en-<ciudad>`), o null si no la tiene. */
export async function getCityPage(
  slug: string,
  pageSlug: string,
): Promise<{
  data: PublicLandingDto;
  page: CityPage<Facility>;
  pages: CityPage<Facility>[];
} | null> {
  const city = cityFromPageSlug(pageSlug);
  if (!city) return null;
  const data = await getLanding(slug);
  if (!data || data.webTemplate === 'external') return null;
  const pages = cityPages(data.facilities);
  const page = pages.find((p) => p.slug === city);
  return page ? { data, page, pages } : null;
}

function minPrice(page: CityPage<Facility>): number | null {
  const prices = page.facilities.flatMap((f) =>
    f.unitTypes.filter((u) => u.available > 0).map((u) => grossPrice(u)),
  );
  return prices.length > 0 ? Math.min(...prices) : null;
}

export async function buildCityMetadata(
  slug: string,
  pageSlug: string,
  locale: PublicWebLocale,
): Promise<Metadata | null> {
  const found = await getCityPage(slug, pageSlug);
  if (!found) return null;
  const { data, page } = found;
  const min = minPrice(page);
  const price = min != null ? formatPrice(min, locale) : null;
  const title =
    locale === 'en'
      ? `Storage units in ${page.name} · ${data.tenantName}`
      : `Trasteros en ${page.name} · ${data.tenantName}`;
  const description =
    locale === 'en'
      ? `${page.facilities.length} storage locations of ${data.tenantName} in ${page.name}${price ? `, from ${price}/month (VAT incl.)` : ''}. Check sizes and availability and book online.`
      : `${page.facilities.length === 1 ? 'Un centro' : `${page.facilities.length} centros`} de ${data.tenantName} en ${page.name}${price ? `, desde ${price}/mes (IVA incl.)` : ''}. Consulta tamaños y disponibilidad y reserva online.`;
  const es = cityPageHref(slug, page.slug, 'es', data.customDomain);
  const en = cityPageHref(slug, page.slug, 'en', data.customDomain);
  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical: locale === 'en' ? en : es,
      languages: { es, en, 'x-default': es },
    },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: data.tenantName,
      locale: locale === 'en' ? 'en_GB' : 'es_ES',
    },
  };
}

export async function CityPageBody({
  slug,
  pageSlug,
  locale,
}: {
  slug: string;
  pageSlug: string;
  locale: PublicWebLocale;
}) {
  const found = await getCityPage(slug, pageSlug);
  if (!found) notFound();
  const { data, page, pages } = found;
  const messages = await getPublicWebMessages(locale);
  const min = minPrice(page);
  const base = data.customDomain ? `https://${data.customDomain}` : `${siteUrl()}/s/${slug}`;
  const pageUrl = `${base}/trasteros-en-${page.slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: `${data.tenantName} — ${page.name}`,
        itemListElement: page.facilities.map((f, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'SelfStorage',
            '@id': `${base}${f.publicSlug ? `/${f.publicSlug}` : ''}#local-${f.id}`,
            name: `${data.tenantName} — ${f.name}`,
            ...(f.address
              ? {
                  address: {
                    '@type': 'PostalAddress',
                    streetAddress: f.address,
                    addressLocality: f.city ?? page.name,
                    ...(f.postalCode ? { postalCode: f.postalCode } : {}),
                    addressCountry: 'ES',
                  },
                }
              : {}),
            ...(f.contactPhone ? { telephone: f.contactPhone } : {}),
          },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: data.tenantName, item: base },
          { '@type': 'ListItem', position: 2, name: page.name, item: pageUrl },
        ],
      },
    ],
  };
  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      <TenantWebChrome
        data={data}
        locale={locale}
        hasBlog={data.hasBlog}
        googleAnalyticsId={data.googleAnalyticsId}
        languageHrefBuilder={(l) => cityPageHref(slug, page.slug, l, data.customDomain)}
      >
        <CityBody
          data={data}
          page={page}
          others={pages
            .filter((p) => p.slug !== page.slug)
            .map((p) => ({ name: p.name, slug: p.slug }))}
          fromPrice={min != null ? formatPrice(min, locale) : null}
          locale={locale}
        />
      </TenantWebChrome>
      <WhatsappFloatButton number={data.whatsappNumber} />
    </NextIntlClientProvider>
  );
}
