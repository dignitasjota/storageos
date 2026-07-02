import { MapPin, Phone, Mail } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

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
      { next: { revalidate: 300 } },
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
    openGraph: { title, description, type: 'website' },
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

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SelfStorage',
    name: `${data.tenantName} — ${f.name}`,
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
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {data.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={data.logoUrl} alt={data.tenantName} className="mb-6 h-12 w-auto object-contain" />
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
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt={`${f.name}`}
              loading="lazy"
              className="aspect-video w-full rounded-md border object-cover"
            />
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
          {f.unitTypes.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{t.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t.available} disponible{t.available === 1 ? '' : 's'}
                </span>
              </span>
              <span className="font-semibold">
                desde {formatPrice(t.priceMonthly)}
                <span className="text-xs font-normal text-muted-foreground">/mes</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Sin disponibilidad ahora mismo. Contáctanos y te avisamos.
        </p>
      )}
    </div>
  );
}
