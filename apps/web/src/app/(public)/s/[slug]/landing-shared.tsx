import { notFound, redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';

import { EscaparateTemplate } from './escaparate-template';
import { getPublicWebMessages, intlLocaleFor, type PublicWebLocale } from './i18n/messages';
import { OnePageTemplate } from './onepage-template';
import { LandingTemplate, priceRangeString } from './templates';
import { TenantWebChrome } from './tenant-web-chrome';

import type { PublicLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Carga la landing del tenant. `null` si no existe (404). Cacheada 5 min (ISR). */
export async function getLanding(slug: string): Promise<PublicLandingDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicLandingDto;
  } catch {
    return null;
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
): Promise<Metadata> {
  const data = await getLanding(slug);
  if (!data) {
    return {
      title: locale === 'en' ? 'Not found' : 'No encontrado',
      robots: { index: false },
    };
  }
  const where = landingCities(data);
  const title =
    locale === 'en'
      ? data.webHeadline
        ? `${data.webHeadline} · ${data.tenantName}`
        : `Storage units${where ? ` in ${where}` : ''} · ${data.tenantName}`
      : data.webHeadline
        ? `${data.webHeadline} · ${data.tenantName}`
        : `Trasteros${where ? ` en ${where}` : ''} · ${data.tenantName}`;
  const description =
    locale === 'en'
      ? `Rent your storage unit with ${data.tenantName}${where ? ` in ${where}` : ''}. Check availability and pricing and book online in minutes.`
      : `Alquila tu trastero con ${data.tenantName}${
          where ? ` en ${where}` : ''
        }. Consulta disponibilidad y precios y reserva online en minutos.`;
  const base = data.customDomain ? `https://${data.customDomain}` : `/s/${slug}`;
  // Con dominio propio activo, el canonical apunta a él (versión canónica);
  // así la ruta `/s/<slug>` de la plataforma no compite por SEO.
  const canonical = locale === 'en' ? `${base}/l/en` : `${base}/`;
  return {
    title,
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
 * Cuerpo de la página de landing del tenant, parametrizado por `locale` —
 * lo comparten la ruta por defecto (`/s/[slug]`, español) y la ruta con
 * segmento de idioma (`/s/[slug]/l/[locale]`).
 */
export async function LandingPageBody({ slug, locale }: { slug: string; locale: PublicWebLocale }) {
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {data.webTemplate === 'onepage' ? (
        // Plantilla «una página»: autocontenida (trae su propio menú + pie).
        <OnePageTemplate data={data} locale={locale} />
      ) : data.webTemplate === 'escaparate' ? (
        // Plantilla «escaparate» multisección: también autocontenida.
        <EscaparateTemplate data={data} locale={locale} />
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
    </NextIntlClientProvider>
  );
}
