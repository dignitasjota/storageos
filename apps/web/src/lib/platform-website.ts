import type { PlatformWebsiteDto } from '@storageos/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Isotipo blanco de la marca: sin logo subido se pinta con el nombre al lado
 * (los SVG de logo completo de la marca llevan el «os» desplazado).
 */
export const DEFAULT_PLATFORM_ICON = '/brand/icon-white.svg';

/**
 * Ajustes de la web de TrasterOS (panel admin → Web de TrasterOS). Si la API no
 * responde, el logo de la marca.
 */
export async function fetchPlatformWebsite(): Promise<PlatformWebsiteDto> {
  try {
    const res = await fetch(`${API_URL}/v1/platform-website`, { next: { revalidate: 60 } });
    if (res.ok) return (await res.json()) as PlatformWebsiteDto;
  } catch {
    /* logo de la marca */
  }
  return { logoUrl: null };
}
