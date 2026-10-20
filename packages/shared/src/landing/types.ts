/**
 * DTOs de la landing pública por tenant (`/s/[slug]`). Datos públicos del
 * negocio y de cada local + disponibilidad, para una página SEO indexable.
 */
import type { PromotionDiscountTypeValue } from '../billing';
import type { OpeningHours } from '../facilities';
import type { WebContent, WebSeo } from '../web';
import type { AreaPageLinkDto, PublicAreaPageContentDto } from '../web/area-pages';
export interface PublicLandingUnitTypeDto {
  id: string;
  name: string;
  available: number;
  /**
   * Sin IVA: el del trastero más barato disponible de ese tamaño en el local
   * (el que se asigna al reservar); agotado, el más barato que tenga.
   */
  priceMonthly: number;
  /** % de IVA del alquiler (21; 0 en viviendas, exentas). */
  taxRate: number;
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
  /** Contenido de la meta tag de verificación de Google Search Console, o null. */
  googleSiteVerification: string | null;
  /** Measurement ID de Google Analytics 4 (`G-XXXXXXXXXX`), o null. */
  googleAnalyticsId: string | null;
  /**
   * Web Premium: plantilla de diseño (`default`/`modern`/`industrial`) + textos
   * personalizados. Sin la feature `web_premium`, el backend fuerza `default` y
   * `headline`/`about` a null y las secciones vacías.
   */
  webTemplate: string;
  /** Cabecera con el color de la marca (y el botón «Reservar» en blanco). */
  webHeaderBranded: boolean;
  webHeadline: string | null;
  webAbout: string | null;
  /**
   * Copy editable de las secciones de las plantillas multisección
   * (`onepage`/`escaparate`). Vacío → cada plantilla usa sus textos por defecto.
   * `null` sin la feature `web_premium`.
   */
  webContent: WebContent | null;
  /** Títulos y descripciones para Google (vacío = generados). `null` sin `web_premium`. */
  webSeo: WebSeo | null;
  /** Texto propio de las páginas de zona (`/trasteros-en-<zona>`). Vacío sin `web_premium`. */
  areaPages: PublicAreaPageContentDto[];
  /** Enlaces a las páginas de zona para el pie de la web. */
  areaLinks: AreaPageLinkDto[];
  /**
   * Número de WhatsApp Business del tenant para el botón de la web (solo con el
   * extra, el número activo y el botón activado). Cifras con prefijo, listo para `wa.me`.
   */
  whatsappNumber: string | null;
  /** Testimonios (reseñas NPS ≥ 9). Vacío si la sección está desactivada. */
  testimonials: PublicTestimonialDto[];
  /** Preguntas frecuentes publicadas. Vacío si la sección está desactivada. */
  faqs: PublicFaqDto[];
  /**
   * Se muestran preguntas frecuentes (las propias o, sin ninguna, las de por
   * defecto). false si el negocio tiene Web Premium y apagó la sección.
   */
  faqEnabled: boolean;
  /** Muestra el formulario de contacto (crea un lead). */
  contactEnabled: boolean;
  facilities: PublicLandingFacilityDto[];
  /** Promoción activa y usable ahora mismo (la más reciente), o null. */
  activePromotion: PublicActivePromotionDto | null;
  /** ¿Tiene al menos una entrada de blog publicada? Controla el enlace "Blog" del nav. */
  hasBlog: boolean;
  /** Las 4 últimas entradas publicadas (plantillas con sección de blog). */
  latestBlogPosts: PublicBlogPostSummaryDto[];
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
  /** Plantilla de la web (las subpáginas toman su aspecto). */
  webTemplate: string;
  /** Cabecera con el color de la marca (y el botón «Reservar» en blanco). */
  webHeaderBranded: boolean;
  hasBlog: boolean;
  /** Measurement ID de Google Analytics 4 (`G-XXXXXXXXXX`), o null. */
  googleAnalyticsId: string | null;
  /** Igual que en `PublicLandingDto`. */
  whatsappNumber: string | null;
  facility: PublicLandingFacilityDto;
  /** Página de la ciudad del local (`/trasteros-en-<ciudad>`), si se muestra por sí misma. */
  cityPage: { name: string; slug: string } | null;
  /**
   * El local es el único de su ciudad: su ficha hace de página de la ciudad
   * (la dirección de la ciudad lleva aquí) y muestra su texto propio.
   */
  areaPage: { name: string; slug: string; content: PublicAreaPageContentDto | null } | null;
  /** El negocio tiene un solo local: la portada es la página principal. */
  singleFacility: boolean;
  /** Enlaces a las páginas de zona para el pie de la web. */
  areaLinks: AreaPageLinkDto[];
}

/** Entrada del blog en el listado público (`/s/<slug>/blog`). */
export interface PublicBlogPostSummaryDto {
  slug: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  publishedAt: string;
}

/**
 * Enlazado interno del blog hacia las páginas de local (SEO: pasa autoridad
 * de las entradas — que suelen atraer tráfico de búsquedas long-tail — a las
 * páginas que convierten). Solo locales con `publicSlug` (enlazables).
 */
export interface PublicBlogFacilityLinkDto {
  publicSlug: string;
  name: string;
  city: string | null;
  /** Precio más bajo disponible ahora mismo (IVA incl.), o null si no hay stock. */
  fromPriceMonthly: number | null;
}

/** Listado de entradas publicadas del blog de un tenant (feature `web_premium`). */
export interface PublicBlogListDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  /** Plantilla de la web (las subpáginas toman su aspecto). */
  webTemplate: string;
  /** Cabecera con el color de la marca (y el botón «Reservar» en blanco). */
  webHeaderBranded: boolean;
  /** Measurement ID de Google Analytics 4 (`G-XXXXXXXXXX`), o null. */
  googleAnalyticsId: string | null;
  posts: PublicBlogPostSummaryDto[];
  facilities: PublicBlogFacilityLinkDto[];
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
  /** Plantilla de la web (las subpáginas toman su aspecto). */
  webTemplate: string;
  /** Cabecera con el color de la marca (y el botón «Reservar» en blanco). */
  webHeaderBranded: boolean;
  /** Measurement ID de Google Analytics 4 (`G-XXXXXXXXXX`), o null. */
  googleAnalyticsId: string | null;
  post: PublicBlogPostContentDto;
  facilities: PublicBlogFacilityLinkDto[];
}

/** Entradas del sitemap público (para `app/sitemap.ts`). */
export interface PublicSitemapEntryDto {
  tenantSlug: string;
  updatedAt: string;
  facilitySlugs: string[];
  /** Slugs de las entradas de blog publicadas (`/s/<slug>/blog/<postSlug>`). */
  blogPostSlugs: string[];
  /** Entradas publicadas con su última modificación (para el `lastmod`). */
  blogPosts: { slug: string; updatedAt: string }[];
  /** Landings de promoción en vigor marcadas como indexables (`/promo/<slug>`). */
  promoSlugs: string[];
  /** Ciudades con página propia (`/trasteros-en-<ciudad>`). */
  citySlugs: string[];
  /**
   * Dominio propio verificado, o null. Con dominio, la web va en el sitemap de
   * su dominio (`https://<dominio>/sitemap.xml`), no en el de la plataforma.
   */
  customDomain: string | null;
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
  /** Favicon de su web, o null (se usa el de TrasterOS). */
  faviconUrl: string | null;
  /** Cuenta suspendida: ni reserva online ni área de clientes. */
  portalUnavailable: boolean;
  /** Suspendida desde hace 15 días o más: su web pública deja de verse. */
  webUnavailable: boolean;
  /** Contacto del negocio para el aviso (del primer local que lo tenga). */
  contactPhone: string | null;
  contactEmail: string | null;
}
