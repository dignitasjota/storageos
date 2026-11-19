import type { PublicTenantBrandDto } from '@storageos/shared';
import type { Metadata } from 'next';

import { SERVER_API_URL, internalApiHeaders } from '@/lib/server-api';

const API_URL = SERVER_API_URL;

/**
 * Favicon de la web pública de un tenant (lo sube en Configuración → Marca).
 * Sin favicon devuelve `{}` y se queda el de TrasterOS del layout raíz.
 */
async function fetchBrand(slug: string): Promise<PublicTenantBrandDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/brand/${encodeURIComponent(slug)}`, {
      headers: internalApiHeaders(),
      next: { revalidate: 60 },
    });
    return res.ok ? ((await res.json()) as PublicTenantBrandDto) : null;
  } catch {
    return null;
  }
}

export async function tenantIconsMetadata(slug: string): Promise<Metadata> {
  const brand = await fetchBrand(slug);
  if (!brand?.faviconUrl) return {};
  const type = brand.faviconUrl.endsWith('.ico') ? 'image/x-icon' : 'image/png';
  return {
    icons: {
      icon: [{ url: brand.faviconUrl, type }],
      shortcut: [{ url: brand.faviconUrl, type }],
      apple: [{ url: brand.faviconUrl }],
    },
  };
}

/**
 * `robots` de una página de la web de un tenant. La cuenta de demostración no
 * es un negocio real: sus páginas nunca se indexan.
 */
export async function tenantRobots(
  slug: string,
  indexable = true,
): Promise<{ index: boolean; follow: boolean }> {
  const brand = await fetchBrand(slug);
  if (brand?.noindex) return { index: false, follow: false };
  return { index: indexable, follow: true };
}
