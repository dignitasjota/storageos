/**
 * DTOs de la landing pública por tenant (`/s/[slug]`). Datos públicos del
 * negocio y de cada local + disponibilidad, para una página SEO indexable.
 */
import type { PromotionDiscountTypeValue } from '../billing';
import type { OpeningHours } from '../facilities';
import type { WebContent } from '../web';
export interface PublicLandingUnitTypeDto {
  id: string;
  name: string;
  available: number;
  priceMonthly: number;
  /** Área representativa del tipo (m²), media de los trasteros disponibles. */
  areaM2: number | null;
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
  openingHours: OpeningHours;
  /** Zona horaria del local (para calcular "abierto ahora" en la web pública). */
  timezone: string;
  /** Coordenadas (para el mapa embebido); null si no están configuradas. */
  latitude: number | null;
  longitude: number | null;
  /** URLs públicas de las imágenes del local. */
  imageUrls: string[];
  /** Vídeo (YouTube/Vimeo) del local, o null. */
  videoUrl: string | null;
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
  /** Enlace a las reseñas de Google del negocio (insignia de confianza), o null. */
  googleReviewUrl: string | null;
  /**
   * Web Premium: plantilla de diseño (`default`/`modern`/`industrial`) + textos
   * personalizados. Sin la feature `web_premium`, el backend fuerza `default` y
   * `headline`/`about` a null y las secciones vacías.
   */
  webTemplate: string;
  webHeadline: string | null;
  webAbout: string | null;
  /**
   * Copy editable de las secciones de las plantillas multisección
   * (`onepage`/`escaparate`). Vacío → cada plantilla usa sus textos por defecto.
   * `null` sin la feature `web_premium`.
   */
  webContent: WebContent | null;
  /** Testimonios (reseñas NPS ≥ 9). Vacío si la sección está desactivada. */
  testimonials: PublicTestimonialDto[];
  /** Preguntas frecuentes publicadas. Vacío si la sección está desactivada. */
  faqs: PublicFaqDto[];
  /** Muestra el formulario de contacto (crea un lead). */
  contactEnabled: boolean;
  facilities: PublicLandingFacilityDto[];
  /** Promoción activa y usable ahora mismo (la más reciente), o null. */
  activePromotion: PublicActivePromotionDto | null;
  /** ¿Tiene al menos una entrada de blog publicada? Controla el enlace "Blog" del nav. */
  hasBlog: boolean;
}

/** Promoción destacable en el banner de la web pública (datos mínimos, no sensibles). */
export interface PublicActivePromotionDto {
  code: string;
  name: string;
  discountType: PromotionDiscountTypeValue;
  discountValue: number;
}

export interface PublicTestimonialDto {
  author: string;
  comment: string;
  /** Estrellas (1-5) si el inquilino las dejó. */
  rating: number | null;
}

export interface PublicFaqDto {
  question: string;
  answer: string;
}

/** Landing de un único local (`/s/<tenant>/<facilitySlug>`). */
export interface PublicFacilityLandingDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  hasBlog: boolean;
  facility: PublicLandingFacilityDto;
}

/** Entrada del blog en el listado público (`/s/<slug>/blog`). */
export interface PublicBlogPostSummaryDto {
  slug: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  publishedAt: string;
}

/** Listado de entradas publicadas del blog de un tenant (feature `web_premium`). */
export interface PublicBlogListDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  posts: PublicBlogPostSummaryDto[];
}

/** Contenido completo de una entrada de blog (`/s/<slug>/blog/<postSlug>`). */
export interface PublicBlogPostContentDto {
  slug: string;
  title: string;
  excerpt: string | null;
  contentMarkdown: string;
  coverImageUrl: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string;
  updatedAt: string;
}

export interface PublicBlogPostDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  post: PublicBlogPostContentDto;
}

/** Entradas del sitemap público (para `app/sitemap.ts`). */
export interface PublicSitemapEntryDto {
  tenantSlug: string;
  updatedAt: string;
  facilitySlugs: string[];
  /** Slugs de las entradas de blog publicadas (`/s/<slug>/blog/<postSlug>`). */
  blogPostSlugs: string[];
}
export interface PublicSitemapDto {
  entries: PublicSitemapEntryDto[];
}

/**
 * URL base de la web externa del tenant (plantilla `external`). La consume la
 * ruta de proxy `/tenant-site/<slug>` del web — endpoint ligero, sin datos de
 * facilities/testimonios.
 */
export interface ExternalSiteDto {
  baseUrl: string;
}

/** Resolución dominio propio → tenant (la usa el middleware del web). */
export interface ResolveDomainDto {
  tenantSlug: string;
  /**
   * ¿Sirve una web externa (proxy inverso hacia una URL que el tenant aloja
   * fuera de la plataforma)? El middleware lo usa para enrutar TODO el
   * dominio propio hacia `/tenant-site/<slug>` en vez de nuestras plantillas.
   */
  hasExternalSite: boolean;
}

/**
 * Marca del operador por slug (ligero). La usa el login del inquilino
 * (`/portal/login?slug=`) para verse con el aspecto white-label del tenant.
 */
export interface PublicTenantBrandDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
}
