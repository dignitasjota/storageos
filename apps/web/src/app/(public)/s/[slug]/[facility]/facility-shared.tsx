import { cityFromPageSlug } from '@storageos/shared';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { buildCityMetadata, CityPageBody } from '../city/city-shared';
import {
  cityPageHref,
  getPublicWebMessages,
  intlLocaleFor,
  landingHref,
  type PublicWebLocale,
} from '../i18n/messages';
import { siteUrl } from '../landing-shared';
import { faqPageLd, localBusinessFields } from '../local-business-ld';
import { priceRangeString } from '../price-format';
import { buildPromoMetadata, lookupPromo, PromoPageView } from '../promo/promo-page';
import { themeFor } from '../promo/promo-theme';
import { TenantWebChrome } from '../tenant-web-chrome';
import { WebChatWidget } from '../web-chat-widget';
import { WhatsappFloatButton } from '../whatsapp-float-button';

import { FacilityBody } from './facility-body';

import type { AreaPageFaq, PublicFacilityLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

import { ApiUnavailableError, SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

export async function getFacility(
  slug: string,
  facility: string,
): Promise<PublicFacilityLandingDto | null> {
  try {
    const res = await fetch(
      `${API_URL}/public/landing/${encodeURIComponent(slug)}/${encodeURIComponent(facility)}`,
      { headers: internalApiHeaders(), next: { revalidate: 60 } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiUnavailableError(res.status);
    return (await res.json()) as PublicFacilityLandingDto;
  } catch (err) {
    // Caído o sin respuesta: error (5xx), no «no existe» (404), para que los
    // buscadores no den de baja la web por una caída.
    throw err instanceof ApiUnavailableError ? err : new ApiUnavailableError(0);
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
  opts: { faqs?: AreaPageFaq[]; pageName?: string } = {},
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
    url: pageUrl,
    ...localBusinessFields(f, { areaServed: data.areaPage?.content?.nearbyAreas ?? [] }),
    ...(priceRange ? { priceRange } : {}),
  };

  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: data.tenantName, item: tenantBase },
      { '@type': 'ListItem', position: 2, name: opts.pageName ?? f.name, item: pageUrl },
    ],
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
  const data = await getFacility(slug, facilitySlug);
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
  const title =
    own?.seoTitle ||
    (locale === 'en'
      ? `Storage units${f.city ? ` in ${f.city}` : ''} — ${f.name} · ${data.tenantName}`
      : `Trasteros${f.city ? ` en ${f.city}` : ''} — ${f.name} · ${data.tenantName}`);
  const description =
    own?.seoDescription ||
    (locale === 'en'
      ? `Rent a storage unit at ${f.name}${f.city ? ` (${f.city})` : ''}. Check sizes, prices and availability and book online.`
      : `Alquila un trastero en ${f.name}${
          f.city ? ` (${f.city})` : ''
        }. Consulta tamaños, precios y disponibilidad y reserva online.`);
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
  const raw = await getFacility(slug, facilitySlug);
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
      <TenantWebChrome
        data={data}
        locale={locale}
        facilitySlug={facilitySlug}
        hasBlog={data.hasBlog}
        googleAnalyticsId={data.googleAnalyticsId}
      >
        <FacilityBody data={data} slug={slug} facilitySlug={facilitySlug} locale={locale} />
      </TenantWebChrome>
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
