import { notFound, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { CabeTemplate } from './cabe-template';
import { CorporateTemplate } from './corporate-template';
import { EscaparateTemplate } from './escaparate-template';
import { HtmlLang } from './html-lang';
import { getPublicWebMessages, intlLocaleFor, type PublicWebLocale } from './i18n/messages';
import { OnePageTemplate } from './onepage-template';
import { OnePageMovilTemplate } from './onepagemovil-template';
import { priceRangeString } from './price-format';
import { ScrollToSection } from './scroll-to-section';
import { LandingTemplate } from './templates';
import { TenantWebChrome } from './tenant-web-chrome';
import { TrstromTemplate } from './trstrom-template';
import { WhatsappFloatButton } from './whatsapp-float-button';

import type { LandingSection, PublicLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

import { safeJsonLd } from '@/lib/json-ld';
import { ApiUnavailableError, SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

/** Carga la landing del tenant. `null` si no existe (404). Cacheada 5 min (ISR). */
export async function getLanding(slug: string): Promise<PublicLandingDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiUnavailableError(res.status);
    return (await res.json()) as PublicLandingDto;
  } catch (err) {
    // Caído o sin respuesta: error (5xx), no «no existe» (404), para que los
    // buscadores no den de baja la web por una caída.
    throw err instanceof ApiUnavailableError ? err : new ApiUnavailableError(0);
  }
}

export function landingCities(data: PublicLandingDto): string {
  const set = [...new Set(data.facilities.map((f) => f.city).filter(Boolean))] as string[];
  return set.join(', ');
}

/** URL pública del sitio (para IDs/URLs absolutas en el JSON-LD). */
export function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

/**
 * Datos estructurados de la landing: `Organization` (con `aggregateRating`/
 * `review` reales de los testimonios NPS) + `WebSite` + un `SelfStorage` por
 * local + `FAQPage` si hay preguntas publicadas. Un `@graph` enlazado por
 * `@id`, no un array suelto.
 */
export function buildLandingJsonLd(data: PublicLandingDto, slug: string, locale: PublicWebLocale) {
  const base = data.customDomain ? `https://${data.customDomain}` : `${siteUrl()}/s/${slug}`;
  const orgId = `${base}/#organization`;

  const rated = data.testimonials.filter(
    (t): t is typeof t & { rating: number } => t.rating != null,
  );
  const avgRating =
    rated.length > 0 ? rated.reduce((sum, t) => sum + t.rating, 0) / rated.length : null;

  const organization = {
    '@type': 'Organization',
    '@id': orgId,
    name: data.tenantName,
    url: base,
    ...(data.logoUrl ? { logo: data.logoUrl } : {}),
    ...(avgRating != null
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Math.round(avgRating * 10) / 10,
            reviewCount: rated.length,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
    ...(rated.length > 0
      ? {
          review: rated.map((t) => ({
            '@type': 'Review',
            author: { '@type': 'Person', name: t.author },
            reviewBody: t.comment,
            reviewRating: {
              '@type': 'Rating',
              ratingValue: t.rating,
              bestRating: 5,
              worstRating: 1,
            },
          })),
        }
      : {}),
  };

  const website = {
    '@type': 'WebSite',
    '@id': `${base}/#website`,
    url: base,
    name: data.tenantName,
    publisher: { '@id': orgId },
    inLanguage: intlLocaleFor(locale),
  };

  const selfStorages = data.facilities.map((f) => {
    const priceRange = priceRangeString(f.unitTypes, locale);
    return {
      '@type': 'SelfStorage',
      '@id': `${base}${f.publicSlug ? `/${f.publicSlug}` : ''}#local-${f.id}`,
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
  });

  const faqPage =
    data.faqs.length > 0
      ? {
          '@type': 'FAQPage',
          mainEntity: data.faqs.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer },
          })),
        }
      : null;

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, ...selfStorages, ...(faqPage ? [faqPage] : [])],
  };
}

/** `hreflang` alternates es/en + x-default, absolutos si hay dominio propio. */
function languageAlternates(
  data: Pick<PublicLandingDto, 'customDomain'>,
  slug: string,
): Record<string, string> {
  const base = data.customDomain ? `https://${data.customDomain}` : `/s/${slug}`;
  return {
    es: `${base}/`,
    en: `${base}/l/en`,
    'x-default': `${base}/`,
  };
}

export async function buildLandingMetadata(
  slug: string,
  locale: PublicWebLocale,
  section?: LandingSection,
): Promise<Metadata> {
  const data = await getLanding(slug);
  if (!data) {
    return {
      title: locale === 'en' ? 'Not found' : 'No encontrado',
      robots: { index: false },
    };
  }
  const where = landingCities(data);
  // Los textos SEO propios se escriben en español: en inglés se usan los generados.
  const seo = locale === 'es' ? (data.webSeo ?? {}) : {};
  const generatedTitle =
    locale === 'en'
      ? data.webHeadline
        ? `${data.webHeadline} · ${data.tenantName}`
        : `Storage units${where ? ` in ${where}` : ''} · ${data.tenantName}`
      : data.webHeadline
        ? `${data.webHeadline} · ${data.tenantName}`
        : `Trasteros${where ? ` en ${where}` : ''} · ${data.tenantName}`;
  const title = seo.homeTitle ?? generatedTitle;
  const generatedDescription =
    locale === 'en'
      ? `Rent your storage unit with ${data.tenantName}${where ? ` in ${where}` : ''}. Check availability and pricing and book online in minutes.`
      : `Alquila tu trastero con ${data.tenantName}${
          where ? ` en ${where}` : ''
        }. Consulta disponibilidad y precios y reserva online en minutos.`;
  const description = seo.homeDescription ?? generatedDescription;
  const base = data.customDomain ? `https://${data.customDomain}` : `/s/${slug}`;
  if (section) return sectionMetadata(data, base, where, section, locale);
  // Con dominio propio activo, el canonical apunta a él (versión canónica);
  // así la ruta `/s/<slug>` de la plataforma no compite por SEO.
  const canonical = locale === 'en' ? `${base}/l/en` : `${base}/`;
  return {
    // Sin la plantilla «· TrasterOS» del layout raíz: es la web del tenant.
    title: { absolute: title },
    description,
    alternates: { canonical, languages: languageAlternates(data, slug) },
    robots: { index: true, follow: true },
    // Solo en el homepage de la propiedad (esta ruta) — es lo que exige el
    // método "Etiqueta HTML" de Google Search Console.
    ...(data.googleSiteVerification
      ? { verification: { google: data.googleSiteVerification } }
      : {}),
    // La imagen se inyecta sola desde `opengraph-image.tsx` de este segmento
    // (convención de Next) — dinámica por tenant (logo/color/nombre propios).
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
 * Título y descripción propios de `/precios` y `/contacto` (direcciones fijas
 * para campañas) con su propia canónica; el contenido es la web de una página.
 */
function sectionMetadata(
  data: PublicLandingDto,
  base: string,
  where: string,
  section: LandingSection,
  locale: PublicWebLocale,
): Metadata {
  const prices = priceRangeString(
    data.facilities.flatMap((f) => f.unitTypes),
    locale,
  );
  // Los textos SEO propios se escriben en español: en inglés se usan los generados.
  const seo = locale === 'es' ? (data.webSeo ?? {}) : {};
  const customTitle = section === 'precios' ? seo.pricesTitle : seo.contactTitle;
  const customDescription = section === 'precios' ? seo.pricesDescription : seo.contactDescription;
  let title: string;
  let generatedDescription: string;
  if (locale === 'en') {
    const inWhere = where ? ` in ${where}` : '';
    title =
      section === 'precios'
        ? `Storage unit prices${inWhere} · ${data.tenantName}`
        : `Contact · ${data.tenantName}`;
    generatedDescription =
      section === 'precios'
        ? `Sizes and prices of ${data.tenantName}'s storage units${inWhere}${
            prices ? ` (${prices})` : ''
          }, VAT included. Book online in minutes.`
        : `Contact ${data.tenantName}${inWhere}: phone, address, opening hours and form.`;
  } else {
    const en = where ? ` en ${where}` : '';
    title =
      customTitle ??
      (section === 'precios'
        ? `Precios de trasteros${en} · ${data.tenantName}`
        : `Contacto · ${data.tenantName}`);
    generatedDescription =
      section === 'precios'
        ? `Tamaños y precios de los trasteros de ${data.tenantName}${en}${
            prices ? ` (${prices})` : ''
          }, con IVA incluido. Reserva online en minutos.`
        : `Contacta con ${data.tenantName}${en}: teléfono, dirección, horario y formulario. Te respondemos lo antes posible.`;
  }
  const description = customDescription ?? generatedDescription;
  const path = locale === 'en' ? `/l/en/${section}` : `/${section}`;
  return {
    // Sin la plantilla «· TrasterOS» del layout raíz: es la web del tenant.
    title: { absolute: title },
    description,
    alternates: {
      canonical: `${base}${path}`,
      languages: {
        es: `${base}/${section}`,
        en: `${base}/l/en/${section}`,
        'x-default': `${base}/${section}`,
      },
    },
    robots: { index: true, follow: true },
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
 * Cuerpo de la página de landing del tenant, parametrizado por `locale` —
 * lo comparten la ruta por defecto (`/s/[slug]`, español) y la ruta con
 * segmento de idioma (`/s/[slug]/l/[locale]`).
 */
export async function LandingPageBody({
  slug,
  locale,
  section,
}: {
  slug: string;
  locale: PublicWebLocale;
  /** `/precios` o `/contacto`: la misma web, bajando sola a esa sección. */
  section?: LandingSection;
}) {
  const data = await getLanding(slug);
  if (!data) notFound();

  // Web «externa»: quien llegue por `/s/<slug>` en el dominio de la
  // plataforma (enlace viejo, o el dominio propio se desverificó tras
  // configurarla) va a la web real del tenant en vez de nuestras plantillas.
  // El backend ya fuerza `webTemplate` a `default` si no hay dominio propio
  // verificado (ver `landing.service.ts`), así que `customDomain` debería
  // venir siempre — si no, cae al `else` de abajo (plantilla por defecto).
  if (data.webTemplate === 'external' && data.customDomain) {
    redirect(`https://${data.customDomain}`);
  }

  // Datos estructurados: Organization+AggregateRating/Review reales, WebSite,
  // un SelfStorage por local y FAQPage si hay preguntas publicadas.
  const jsonLd = buildLandingJsonLd(data, slug, locale);
  const messages = await getPublicWebMessages(locale);

  return (
    <NextIntlClientProvider locale={intlLocaleFor(locale)} messages={messages}>
      <HtmlLang locale={locale} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      {section && <ScrollToSection section={section} />}
      {data.webTemplate === 'onepage' ? (
        // Plantilla «una página»: autocontenida (trae su propio menú + pie).
        <OnePageTemplate data={data} locale={locale} />
      ) : data.webTemplate === 'escaparate' ? (
        // Plantilla «escaparate» multisección: también autocontenida.
        <EscaparateTemplate data={data} locale={locale} />
      ) : data.webTemplate === 'cabe' ? (
        // Plantilla «Cabe»: autocontenida, estilo urbano y minimalista.
        <CabeTemplate data={data} locale={locale} />
      ) : data.webTemplate === 'trstrom' ? (
        // Plantilla «Trstrom»: autocontenida, trasteros por centro.
        <TrstromTemplate data={data} locale={locale} />
      ) : data.webTemplate === 'onepagemovil' ? (
        // Plantilla «OnePageMovil»: autocontenida, pensada para el móvil.
        <OnePageMovilTemplate data={data} locale={locale} />
      ) : data.webTemplate === 'corporate' ? (
        // Plantilla «corporativa» (quiénes somos + soluciones): también autocontenida.
        <CorporateTemplate data={data} locale={locale} />
      ) : (
        <TenantWebChrome
          data={data}
          locale={locale}
          hasBlog={data.hasBlog}
          googleAnalyticsId={data.googleAnalyticsId}
        >
          <LandingTemplate data={data} locale={locale} />
        </TenantWebChrome>
      )}
      <WhatsappFloatButton number={data.whatsappNumber} />
    </NextIntlClientProvider>
  );
}
