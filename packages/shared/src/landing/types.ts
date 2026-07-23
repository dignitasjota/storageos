/**
 * DTOs de la landing pública por tenant (`/s/[slug]`). Datos públicos del
 * negocio y de cada local + disponibilidad, para una página SEO indexable.
 */
export interface PublicLandingUnitTypeDto {
  id: string;
  name: string;
  available: number;
  priceMonthly: number;
}

export interface PublicLandingFacilityDto {
  id: string;
  /** Slug público del local para su página SEO (`/s/<tenant>/<slug>`). */
  publicSlug: string | null;
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  openingHours: Record<string, unknown>;
  /** URLs públicas de las imágenes del local. */
  imageUrls: string[];
  unitTypes: PublicLandingUnitTypeDto[];
}

export interface PublicLandingDto {
  tenantName: string;
  tenantSlug: string;
  /** Marca del operador (white-label): color hex y logo, o null. */
  brandColor: string | null;
  logoUrl: string | null;
  /** Dominio propio activo (verificado), o null → canonical al dominio custom. */
  customDomain: string | null;
  /**
   * Web Premium: plantilla de diseño (`default`/`modern`/`industrial`) + textos
   * personalizados. Sin la feature `web_premium`, el backend fuerza `default` y
   * `headline`/`about` a null.
   */
  webTemplate: string;
  webHeadline: string | null;
  webAbout: string | null;
  facilities: PublicLandingFacilityDto[];
}

/** Landing de un único local (`/s/<tenant>/<facilitySlug>`). */
export interface PublicFacilityLandingDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  facility: PublicLandingFacilityDto;
}

/** Entradas del sitemap público (para `app/sitemap.ts`). */
export interface PublicSitemapEntryDto {
  tenantSlug: string;
  updatedAt: string;
  facilitySlugs: string[];
}
export interface PublicSitemapDto {
  entries: PublicSitemapEntryDto[];
}

/** Resolución dominio propio → tenant (la usa el middleware del web). */
export interface ResolveDomainDto {
  tenantSlug: string;
}
