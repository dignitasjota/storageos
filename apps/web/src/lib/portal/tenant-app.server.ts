import { isValidTenantSlug } from './tenant-app';

import type { PublicTenantBrandDto } from '@storageos/shared';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

/** Marca pública del operador (solo servidor), o null si no existe. */
export async function fetchPortalBrand(slug: string): Promise<PublicTenantBrandDto | null> {
  if (!isValidTenantSlug(slug)) return null;
  try {
    const res = await fetch(`${SERVER_API_URL}/public/landing/brand/${encodeURIComponent(slug)}`, {
      headers: internalApiHeaders(),
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicTenantBrandDto;
  } catch {
    return null;
  }
}
