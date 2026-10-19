import type { PublicTenantBrandDto } from '@storageos/shared';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

/** Marca pública de un negocio por su slug (servidor), o null. */
export async function fetchTenantBrand(
  slug: string | undefined,
): Promise<PublicTenantBrandDto | null> {
  if (!slug || !/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  try {
    const res = await fetch(`${SERVER_API_URL}/public/landing/brand/${encodeURIComponent(slug)}`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicTenantBrandDto;
  } catch {
    return null;
  }
}
