import { MapPin, Phone, Mail } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { PublicLandingDto } from '@storageos/shared';
import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Carga la landing del tenant. `null` si no existe (404). Cacheada 5 min (ISR). */
async function getLanding(slug: string): Promise<PublicLandingDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicLandingDto;
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

function cities(data: PublicLandingDto): string {
  const set = [...new Set(data.facilities.map((f) => f.city).filter(Boolean))] as string[];
  return set.join(', ');
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
  const title = `Trasteros${where ? ` en ${where}` : ''} · ${data.tenantName}`;
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
    openGraph: { title, description, type: 'website' },
  };
}

export default async function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getLanding(slug);
  if (!data) notFound();

  const where = cities(data);
  // Datos estructurados para SEO local (un SelfStorage por local con plazas).
  const jsonLd = data.facilities.map((f) => ({
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
  }));

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <header className="mb-10 text-center">
        {data.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.logoUrl}
            alt={data.tenantName}
            className="mx-auto mb-6 h-14 w-auto object-contain"
          />
        )}
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Trasteros{where ? ` en ${where}` : ''}
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          {data.tenantName} · consulta disponibilidad y reserva online en minutos.
        </p>
        <Link
          href={`/book/${data.tenantSlug}`}
          className="mt-6 inline-flex h-11 items-center rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
          style={{ backgroundColor: data.brandColor ?? 'hsl(var(--primary))' }}
        >
          Reservar ahora
        </Link>
      </header>

      {data.facilities.length === 0 ? (
        <p className="rounded-md border bg-card px-4 py-10 text-center text-muted-foreground">
          Ahora mismo no hay trasteros disponibles. Vuelve pronto o contáctanos.
        </p>
      ) : (
        <div className="space-y-6">
          {data.facilities.map((f) => (
            <section key={f.id} className="rounded-lg border bg-card p-6 shadow-sm">
              <h2 className="text-xl font-semibold">{f.name}</h2>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
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
                        desde {formatPrice(t.priceMonthly * 1.21)}
                        <span className="text-xs font-normal text-muted-foreground">
                          /mes · IVA incl.
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">
                  Sin disponibilidad ahora mismo.
                </p>
              )}

              <Link
                href={
                  f.publicSlug
                    ? `/s/${data.tenantSlug}/${f.publicSlug}`
                    : `/book/${data.tenantSlug}`
                }
                className="mt-4 inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-accent"
              >
                {f.publicSlug ? `Ver ${f.name}` : `Reservar en ${f.name}`}
              </Link>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
