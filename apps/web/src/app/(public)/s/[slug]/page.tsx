import { notFound, redirect } from 'next/navigation';

import { EscaparateTemplate } from './escaparate-template';
import { OnePageTemplate } from './onepage-template';
import { LandingTemplate } from './templates';
import { TenantWebChrome } from './tenant-web-chrome';

import type { PublicLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Carga la landing del tenant. `null` si no existe (404). Cacheada 5 min (ISR). */
async function getLanding(slug: string): Promise<PublicLandingDto | null> {
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

function cities(data: PublicLandingDto): string {
  const set = [...new Set(data.facilities.map((f) => f.city).filter(Boolean))] as string[];
  return set.join(', ');
}

/** URL pública del sitio (para IDs/URLs absolutas en el JSON-LD). */
function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

/**
 * Datos estructurados de la landing: `Organization` (con `aggregateRating`/
 * `review` reales de los testimonios NPS) + `WebSite` + un `SelfStorage` por
 * local + `FAQPage` si hay preguntas publicadas. Antes solo se emitía un
 * array suelto de `SelfStorage`; ahora es un `@graph` enlazado por `@id`.
 */
function buildJsonLd(data: PublicLandingDto, slug: string) {
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
    inLanguage: 'es-ES',
  };

  const selfStorages = data.facilities.map((f) => ({
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
  }));

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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await getLanding(slug);
  if (!data) return { title: 'No encontrado', robots: { index: false } };
  const where = cities(data);
  const title = data.webHeadline
    ? `${data.webHeadline} · ${data.tenantName}`
    : `Trasteros${where ? ` en ${where}` : ''} · ${data.tenantName}`;
  const description = `Alquila tu trastero con ${data.tenantName}${
    where ? ` en ${where}` : ''
  }. Consulta disponibilidad y precios y reserva online en minutos.`;
  // Con dominio propio activo, el canonical apunta a él (versión canónica);
  // así la ruta `/s/<slug>` de la plataforma no compite por SEO.
  const canonical = data.customDomain ? `https://${data.customDomain}/` : `/s/${slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    // La imagen se inyecta sola desde `opengraph-image.tsx` de este segmento
    // (convención de Next) — dinámica por tenant (logo/color/nombre propios).
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: data.tenantName,
      locale: 'es_ES',
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
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
  const jsonLd = buildJsonLd(data, slug);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {data.webTemplate === 'onepage' ? (
        // Plantilla «una página»: autocontenida (trae su propio menú + pie).
        <OnePageTemplate data={data} />
      ) : data.webTemplate === 'escaparate' ? (
        // Plantilla «escaparate» multisección: también autocontenida.
        <EscaparateTemplate data={data} />
      ) : (
        <TenantWebChrome data={data}>
          <LandingTemplate data={data} />
        </TenantWebChrome>
      )}
    </>
  );
}
