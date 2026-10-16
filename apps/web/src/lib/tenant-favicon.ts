import type { PublicTenantBrandDto } from '@storageos/shared';
import type { Metadata } from 'next';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Favicon de la web pública de un tenant (lo sube en Configuración → Marca).
 * Sin favicon devuelve `{}` y se queda el de TrasterOS del layout raíz.
 */
export async function tenantIconsMetadata(slug: string): Promise<Metadata> {
  try {
    const res = await fetch(`${API_URL}/public/landing/brand/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return {};
    const brand = (await res.json()) as PublicTenantBrandDto;
    if (!brand.faviconUrl) return {};
    const type = brand.faviconUrl.endsWith('.ico') ? 'image/x-icon' : 'image/png';
    return {
      icons: {
        icon: [{ url: brand.faviconUrl, type }],
        shortcut: [{ url: brand.faviconUrl, type }],
        apple: [{ url: brand.faviconUrl }],
      },
    };
  } catch {
    return {};
  }
}
