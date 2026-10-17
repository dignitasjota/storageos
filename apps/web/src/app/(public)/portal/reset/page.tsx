import { headers } from 'next/headers';

import { PortalResetClient } from './portal-reset-client';

import type { PublicTenantBrandDto } from '@storageos/shared';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

async function fetchBrand(slug: string): Promise<PublicTenantBrandDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/brand/${encodeURIComponent(slug)}`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicTenantBrandDto;
  } catch {
    return null;
  }
}

/**
 * El enlace de reset (por email) no lleva `?slug=` — solo el token. La marca
 * del tenant se resuelve por la cabecera que fija el middleware cuando el
 * enlace apunta al dominio propio del tenant (`PortalService.portalBaseUrl`
 * ya usa ese dominio si está verificado); sin dominio propio, se muestra el
 * aspecto genérico (no hay forma de identificar al tenant antes del token).
 */
export default async function PortalResetPage() {
  const h = await headers();
  const slug = h.get('x-storageos-tenant-slug');
  const brand = slug ? await fetchBrand(slug) : null;

  return <PortalResetClient initialBrand={brand} />;
}
