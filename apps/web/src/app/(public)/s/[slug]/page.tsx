import { notFound } from 'next/navigation';

import { LandingTemplate } from './templates';

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
    openGraph: { title, description, type: 'website' },
  };
}

export default async function LandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getLanding(slug);
  if (!data) notFound();

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
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingTemplate data={data} />
    </>
  );
}
