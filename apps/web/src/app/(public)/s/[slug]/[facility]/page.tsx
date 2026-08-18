import { MapPin, Phone, Mail } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { TenantWebChrome } from '../tenant-web-chrome';

import type { PublicFacilityLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function getFacility(
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

function formatPrice(n: number): string {
  return n.toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
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
 * Datos estructurados de la ficha de local: `Organization`+`WebSite`, el
 * `SelfStorage` (con imágenes) y `BreadcrumbList` (coherente con el
 * breadcrumb visual ya renderizado en la página). Sin `AggregateRating`/
 * `FAQPage` aquí — `PublicFacilityLandingDto` no trae testimonios/FAQ (son
 * tenant-wide, no por local); si se quiere en el futuro, la landing del
 * tenant (`/s/[slug]`) ya los emite.
 */
function buildJsonLd(data: PublicFacilityLandingDto, slug: string, facilitySlug: string) {
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
    inLanguage: 'es-ES',
  };

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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; facility: string }>;
}): Promise<Metadata> {
  const { slug, facility } = await params;
  const data = await getFacility(slug, facility);
  if (!data) return { title: 'No encontrado', robots: { index: false } };
  const f = data.facility;
  const where = f.city ? ` en ${f.city}` : '';
  const title = `Trasteros${where} — ${f.name} · ${data.tenantName}`;
  const description = `Alquila un trastero en ${f.name}${
    f.city ? ` (${f.city})` : ''
  }. Consulta tamaños, precios y disponibilidad y reserva online.`;
  // Con dominio propio activo, el canonical apunta a él (el local vive en
  // `midominio.com/<facilitySlug>`).
  const canonical = data.customDomain
    ? `https://${data.customDomain}/${facility}`
    : `/s/${slug}/${facility}`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    // Sin `opengraph-image.tsx` propio para este segmento: hereda el del
    // tenant en `/s/[slug]/opengraph-image.tsx` (convención de Next).
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

export default async function FacilityLandingPage({
  params,
}: {
  params: Promise<{ slug: string; facility: string }>;
}) {
  const { slug, facility } = await params;
  const data = await getFacility(slug, facility);
  if (!data) notFound();
  const f = data.facility;
  const jsonLd = buildJsonLd(data, slug, facility);

  return (
    <TenantWebChrome data={data}>
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

        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Trasteros{f.city ? ` en ${f.city}` : ''} — {f.name}
        </h1>

        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          {(f.address || f.city) && (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="h-4 w-4" />
              {[f.address, f.postalCode, f.city].filter(Boolean).join(', ')}
            </span>
          )}
          {f.contactPhone && (
            <a
              href={`tel:${f.contactPhone}`}
              className="inline-flex items-center gap-1.5 hover:text-foreground"
            >
              <Phone className="h-4 w-4" /> {f.contactPhone}
            </a>
          )}
          {f.contactEmail && (
            <a
              href={`mailto:${f.contactEmail}`}
              className="inline-flex items-center gap-1.5 hover:text-foreground"
            >
              <Mail className="h-4 w-4" /> {f.contactEmail}
            </a>
          )}
        </div>

        {f.imageUrls.length > 0 && (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {f.imageUrls.map((url) => (
              <div
                key={url}
                className="relative aspect-video w-full overflow-hidden rounded-md border"
              >
                <Image
                  src={url}
                  alt={`${f.name}`}
                  fill
                  loading="lazy"
                  sizes="(min-width: 640px) 33vw, 50vw"
                  className="object-cover"
                />
              </div>
            ))}
          </div>
        )}

        <Link
          href={`/book/${data.tenantSlug}`}
          className="mt-6 inline-flex h-11 items-center rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
          style={{ backgroundColor: data.brandColor ?? 'hsl(var(--primary))' }}
        >
          Reservar ahora
        </Link>

        <h2 className="mt-10 text-xl font-semibold">Tamaños y precios</h2>
        {f.unitTypes.length > 0 ? (
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {f.unitTypes.map((t) => {
              const soldOut = t.available === 0;
              return (
                <li
                  key={t.id}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                    soldOut ? 'opacity-60' : ''
                  }`}
                >
                  <span>
                    <span className="font-medium">{t.name}</span>
                    <span
                      className={`ml-2 text-xs ${soldOut ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
                    >
                      {soldOut
                        ? 'Agotado'
                        : `${t.available} disponible${t.available === 1 ? '' : 's'}`}
                    </span>
                  </span>
                  <span className="font-semibold">
                    desde {formatPrice(t.priceMonthly * 1.21)}
                    <span className="text-xs font-normal text-muted-foreground">
                      /mes · IVA incl.
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Sin disponibilidad ahora mismo. Contáctanos y te avisamos.
          </p>
        )}
      </div>
    </TenantWebChrome>
  );
}
