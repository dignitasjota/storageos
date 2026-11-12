import { cityFromPageSlug } from '@storageos/shared';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { createTranslator, NextIntlClientProvider } from 'next-intl';

import { buildCityMetadata, CityPageBody } from '../city/city-shared';
import {
  cityPageHref,
  facilityHref,
  getPublicWebMessages,
  intlLocaleFor,
  landingHref,
  type PublicWebLocale,
} from '../i18n/messages';
import { siteUrl } from '../landing-shared';
import { faqPageLd, localBusinessFields } from '../local-business-ld';
import { grossPrice, priceRangeString } from '../price-format';
import { buildPromoMetadata, lookupPromo, PromoPageView } from '../promo/promo-page';
import { themeFor } from '../promo/promo-theme';
import { TenantSiteChrome } from '../tenant-site-chrome';
import { WebChatWidget } from '../web-chat-widget';
import { WhatsappFloatButton } from '../whatsapp-float-button';

import { FacilityBody } from './facility-body';
import { facilityDescription, facilityTitle, type PublicWebT } from './facility-seo';

import type { AreaPageFaq, PublicFacilityLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

import { ApiUnavailableError, SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

/** `movedTo`: dirección antigua de un local, que ahora está en otra. */
async function lookupFacility(
  slug: string,
  facility: string,
): Promise<PublicFacilityLandingDto | { movedTo: string } | null> {
  try {
    const res = await fetch(
      `${API_URL}/public/landing/${encodeURIComponent(slug)}/${encodeURIComponent(facility)}`,
      { headers: internalApiHeaders(), next: { revalidate: 60 } },
    );
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        details?: { slug?: string };
      } | null;
      return body?.code === 'facility_moved' && body.details?.slug
        ? { movedTo: body.details.slug }
        : null;
    }
    if (!res.ok) throw new ApiUnavailableError(res.status);
    return (await res.json()) as PublicFacilityLandingDto;
  } catch (err) {
    // Caído o sin respuesta: error (5xx), no «no existe» (404), para que los
    // buscadores no den de baja la web por una caída.
    throw err instanceof ApiUnavailableError ? err : new ApiUnavailableError(0);
  }
}

export async function getFacility(
  slug: string,
  facility: string,
): Promise<PublicFacilityLandingDto | null> {
  const found = await lookupFacility(slug, facility);
  return found && 'movedTo' in found ? null : found;
}

/**
 * Datos estructurados de la ficha de local: `Organization`+`WebSite`, el
 * `SelfStorage` (con imágenes, descripción, características y los tamaños con
 * su precio), `BreadcrumbList` (los mismos niveles que el de la página) y
 * `FAQPage` con las preguntas que se ven.
 */
export function buildFacilityJsonLd(
  data: PublicFacilityLandingDto,
  slug: string,
  facilitySlug: string,
  locale: PublicWebLocale,
  opts: {
    faqs?: AreaPageFaq[];
    pageName?: string;
    /** El párrafo de presentación que se ve en la página. */
    description?: string;
    /** Nombre de cada característica (24 h, climatizado…) en el idioma de la página. */
    featureNames?: string[];
  } = {},
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
  const en = locale === 'en';
  // Cada tamaño con su precio al mes (IVA incluido), como se ve en la página.
  const offers = f.unitTypes.map((u) => ({
    '@type': 'Offer',
    name: `${en ? 'Storage unit' : 'Trastero'} ${u.name}${f.city ? ` ${en ? 'in' : 'en'} ${f.city}` : ''}`,
    price: Math.round(grossPrice(u) * 100) / 100,
    priceCurrency: 'EUR',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: Math.round(grossPrice(u) * 100) / 100,
      priceCurrency: 'EUR',
      unitCode: 'MON',
      valueAddedTaxIncluded: true,
    },
    availability: u.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    ...(u.areaM2 ? { description: `${u.areaM2} m²` } : {}),
  }));
  const selfStorage = {
    '@type': 'SelfStorage',
    '@id': `${pageUrl}#local`,
    name: `${data.tenantName} — ${f.name}`,
    ...(opts.description ? { description: opts.description } : {}),
    parentOrganization: { '@id': orgId },
    ...(f.imageUrls.length > 0 ? { image: f.imageUrls } : {}),
    url: pageUrl,
    ...localBusinessFields(f, { areaServed: data.areaPage?.content?.nearbyAreas ?? [] }),
    ...(priceRange ? { priceRange } : {}),
    currenciesAccepted: 'EUR',
    ...(opts.featureNames && opts.featureNames.length > 0
      ? {
          amenityFeature: opts.featureNames.map((name) => ({
            '@type': 'LocationFeatureSpecification',
            name,
            value: true,
          })),
        }
      : {}),
    ...(offers.length > 0 ? { makesOffer: offers } : {}),
  };

  // Los mismos niveles que se ven: negocio › ciudad (si hay página) › local.
  const cityUrl =
    data.cityPage && !opts.pageName
      ? cityPageHref(data.tenantSlug, data.cityPage.slug, locale, data.customDomain)
      : null;
  const crumbs = [
    { name: data.tenantName, item: tenantBase },
    ...(cityUrl && data.cityPage
      ? [
          {
            name: en
              ? `Storage units in ${data.cityPage.name}`
              : `Trasteros en ${data.cityPage.name}`,
            item: cityUrl.startsWith('http') ? cityUrl : `${siteUrl()}${cityUrl}`,
          },
        ]
      : []),
    { name: opts.pageName ?? f.name, item: pageUrl },
  ];
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, ...c })),
  };

  // Las mismas preguntas que se ven en la página.
  const faq = faqPageLd(opts.faqs ?? data.areaPage?.content?.faqs ?? [], `${pageUrl}#faq`);
  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, selfStorage, breadcrumb, ...(faq ? [faq] : [])],
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

/**
 * Landing de promoción con dirección corta: solo en el dominio propio (la
 * cabecera del middleware lo confirma) y en español. Un local o una página de
 * ciudad con el mismo nombre ganan, porque se buscan antes.
 */
async function shortPathPromo(
  slug: string,
  segment: string,
  locale: PublicWebLocale,
  onCustomDomain: boolean,
) {
  if (locale !== 'es' || !onCustomDomain) return null;
  return lookupPromo(slug, segment, { viaShortPath: true });
}

export async function buildFacilityMetadata(
  slug: string,
  facilitySlug: string,
  locale: PublicWebLocale,
  /** Visto desde el dominio propio (la página lo sabe por la cabecera del middleware). */
  onCustomDomain = false,
): Promise<Metadata> {
  const found = await lookupFacility(slug, facilitySlug);
  if (found && 'movedTo' in found) return { robots: { index: false, follow: true } };
  const data = found;
  if (!data) {
    // `trasteros-en-<ciudad>`: página de la ciudad (si el negocio la tiene).
    const city = await buildCityMetadata(slug, facilitySlug, locale);
    if (city) return city;
    const promo = await shortPathPromo(slug, facilitySlug, locale, onCustomDomain);
    if (promo && 'page' in promo) return buildPromoMetadata(promo.page, slug);
    return {
      title: locale === 'en' ? 'Not found' : 'No encontrado',
      robots: { index: false },
    };
  }
  // Único local de su ciudad: la buena es la página de la ciudad (redirige).
  if (data.areaPage && !data.singleFacility) return { robots: { index: false, follow: true } };
  const f = data.facility;
  // Los textos propios de la ciudad están en español.
  const own = locale === 'es' ? data.areaPage?.content : null;
  const t = createTranslator({
    locale: intlLocaleFor(locale),
    messages: await getPublicWebMessages(locale),
    namespace: 'publicWeb',
  }) as unknown as PublicWebT;
  // Localidad, tamaños y precio en el título y la descripción (lo que se busca).
  const title = own?.seoTitle || facilityTitle(f, data.tenantName, locale);
  const description = own?.seoDescription || facilityDescription(t, f, data.tenantName, locale);
  const base = data.customDomain
    ? `https://${data.customDomain}/${facilitySlug}`
    : `/s/${slug}/${facilitySlug}`;
  // Con un solo local, la portada es la página principal (esta repite su contenido).
  const canonical = data.singleFacility
    ? landingHref(slug, locale, data.customDomain)
    : locale === 'en'
      ? data.customDomain
        ? `https://${data.customDomain}/l/en/${facilitySlug}`
        : `/s/${slug}/l/en/${facilitySlug}`
      : base;
  return {
    // Sin la plantilla «· TrasterOS» del layout raíz: es la web del tenant.
    title: { absolute: title },
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
  onCustomDomain = false,
}: {
  slug: string;
  facilitySlug: string;
  locale: PublicWebLocale;
  /** Visto desde el dominio propio: habilita la dirección corta de las landings. */
  onCustomDomain?: boolean;
}) {
  const raw = await lookupFacility(slug, facilitySlug);
  if (raw && 'movedTo' in raw) {
    const segment = encodeURIComponent(raw.movedTo);
    permanentRedirect(
      !onCustomDomain
        ? facilityHref(slug, raw.movedTo, locale)
        : locale === 'es'
          ? `/${segment}`
          : `/l/${locale}/${segment}`,
    );
  }
  if (!raw) {
    if (cityFromPageSlug(facilitySlug)) {
      return <CityPageBody slug={slug} pageSlug={facilitySlug} locale={locale} />;
    }
    // Dirección corta de una landing de promoción (`/<nombre>` en el dominio propio).
    const promo = await shortPathPromo(slug, facilitySlug, locale, onCustomDomain);
    if (promo && 'page' in promo) return <PromoPageView data={promo.page} />;
    if (promo) redirect('/');
    notFound();
  }
  // Único local de su ciudad: la página de la ciudad muestra esta ficha.
  if (raw.areaPage && !raw.singleFacility) {
    permanentRedirect(cityPageHref(slug, raw.areaPage.slug, locale, raw.customDomain));
  }
  // El color de la plantilla si el negocio no ha elegido uno (como la portada).
  const data = { ...raw, brandColor: themeFor(raw.webTemplate, raw.brandColor).accent };
  const messages = await getPublicWebMessages(locale);

  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <TenantSiteChrome
        slug={slug}
        fallback={data}
        locale={locale}
        hideReserve={false}
        googleAnalyticsId={data.googleAnalyticsId}
        languageHrefBuilder={(l) => facilityHref(slug, facilitySlug, l, data.customDomain)}
      >
        <FacilityBody data={data} slug={slug} facilitySlug={facilitySlug} locale={locale} />
      </TenantSiteChrome>
      <WhatsappFloatButton number={data.whatsappNumber} facilityName={data.facility.name} />
      <WebChatWidget
        slug={data.tenantSlug}
        enabled={data.webChatEnabled}
        tenantName={data.tenantName}
        brandColor={data.brandColor}
        customDomain={data.customDomain}
        aboveWhatsapp={!!data.whatsappNumber}
      />
    </NextIntlClientProvider>
  );
}
