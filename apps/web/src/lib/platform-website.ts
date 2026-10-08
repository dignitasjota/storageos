import {
  DEFAULT_PLATFORM_FOOTER,
  DEFAULT_PLATFORM_SEO,
  type PlatformWebsiteDto,
} from '@storageos/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Isotipo blanco de la marca: sin logo subido se pinta con el nombre al lado
 * (los SVG de logo completo de la marca llevan el «os» desplazado).
 */
export const DEFAULT_PLATFORM_ICON = '/brand/icon-white.svg';

const FALLBACK: PlatformWebsiteDto = {
  logoUrl: null,
  contactForm: null,
  footer: DEFAULT_PLATFORM_FOOTER,
  seo: { ...DEFAULT_PLATFORM_SEO, ogImageUrl: null },
};

/**
 * Ajustes de la web de TrasterOS (panel admin → Web de TrasterOS). Si la API no
 * responde, o es de una versión anterior sin algún apartado (pasa durante un
 * despliegue, cuando la web se construye contra la API vieja), se completa con
 * los valores por defecto.
 */
export async function fetchPlatformWebsite(): Promise<PlatformWebsiteDto> {
  try {
    const res = await fetch(`${API_URL}/v1/platform-website`, { next: { revalidate: 60 } });
    if (res.ok) {
      const data = (await res.json()) as Partial<PlatformWebsiteDto>;
      return {
        logoUrl: data.logoUrl ?? null,
        contactForm: data.contactForm ?? null,
        footer: data.footer ?? FALLBACK.footer,
        seo: { ...FALLBACK.seo, ...(data.seo ?? {}) },
      };
    }
  } catch {
    /* valores por defecto */
  }
  return FALLBACK;
}
