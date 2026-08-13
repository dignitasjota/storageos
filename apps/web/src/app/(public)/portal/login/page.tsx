import { headers } from 'next/headers';

import { PortalLoginClient } from './portal-login-client';

import type { PublicTenantBrandDto } from '@storageos/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function fetchBrand(slug: string): Promise<PublicTenantBrandDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/brand/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicTenantBrandDto;
  } catch {
    return null;
  }
}

/**
 * Resuelve el tenant del login (para mostrarlo con su aspecto white-label)
 * por dos vías: `?slug=` (enlace «Acceso clientes» de nuestras plantillas,
 * prioritario) o, si se accede por el dominio propio del tenant, la cabecera
 * que fija el middleware — cubre el caso de un enlace tecleado a mano o
 * enlazado desde una web externa que el tenant aloja fuera de la plataforma.
 */
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  const { slug: querySlug } = await searchParams;
  const h = await headers();
  const domainSlug = h.get('x-storageos-tenant-slug');
  const slug = querySlug || domainSlug || null;
  const brand = slug ? await fetchBrand(slug) : null;

  return <PortalLoginClient initialSlug={slug} initialBrand={brand} />;
}
