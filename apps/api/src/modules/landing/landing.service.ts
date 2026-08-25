import { Injectable, NotFoundException } from '@nestjs/common';
import {
  effectiveFeaturesFromList,
  isValidCustomDomain,
  isWebTemplate,
  parseWebContent,
  parseWebSections,
  resolvePlanFeatures,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';
import { LeadsService } from '../leads/leads.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  LeadDto,
  OpeningHours,
  PublicContactInput,
  PublicFaqDto,
  PublicTestimonialDto,
  TenantFeature,
} from '@storageos/shared';
import type {
  ExternalSiteDto,
  PublicActivePromotionDto,
  PublicBlogListDto,
  PublicBlogPostDto,
  PublicFacilityLandingDto,
  PublicLandingDto,
  PublicLandingFacilityDto,
  PublicSitemapDto,
  PublicTenantBrandDto,
  ResolveDomainDto,
} from '@storageos/shared';

/**
 * Datos públicos para la landing por tenant (`/s/[slug]`). Sin auth ni RLS:
 * usa `PrismaAdminService` resolviendo el tenant por slug, igual que el
 * widget/booking públicos. Solo expone información de marketing + disponibilidad
 * (nunca datos de clientes ni internos).
 */
@Injectable()
export class LandingService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly leads: LeadsService,
  ) {}

  async getBySlug(slug: string): Promise<PublicLandingDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }

    const [facilities, unitTypes, grouped] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId: tenant.id, deletedAt: null, isActive: true },
        select: {
          id: true,
          publicSlug: true,
          name: true,
          address: true,
          city: true,
          postalCode: true,
          contactPhone: true,
          contactEmail: true,
          openingHours: true,
          timezone: true,
          latitude: true,
          longitude: true,
          images: true,
          videoUrl: true,
        },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, defaultPriceMonthly: true },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id, status: 'available' },
        _count: { _all: true },
        _avg: { areaM2: true },
      }),
    ]);

    const availByFacilityType = new Map<string, number>();
    const areaByFacilityType = new Map<string, number | null>();
    for (const g of grouped) {
      availByFacilityType.set(`${g.facilityId}:${g.unitTypeId}`, g._count._all);
      const avg = g._avg.areaM2;
      areaByFacilityType.set(
        `${g.facilityId}:${g.unitTypeId}`,
        avg != null ? Math.round(Number(avg) * 10) / 10 : null,
      );
    }

    // Web Premium: solo si el tenant tiene la feature se aplica la plantilla y los
    // textos personalizados; si no, se sirve `default` sin headline/about custom.
    const hasWebPremium = await this.hasWebPremium(tenant.id);
    let webTemplate =
      hasWebPremium && isWebTemplate(tenant.webTemplate) ? tenant.webTemplate : 'default';
    // `external` (proxy hacia la web propia del tenant) exige dominio propio
    // VERIFICADO — si se desverificó tras configurarla, cae a `default` en vez
    // de dejar una página rota (mismo criterio que el gating de `web_premium`).
    if (webTemplate === 'external' && !tenant.customDomainVerifiedAt) {
      webTemplate = 'default';
    }
    const sections = hasWebPremium
      ? parseWebSections(tenant.webSections)
      : { testimonials: false, faq: false, contact: false };
    const [testimonials, faqs, activePromotion, blogCount] = await Promise.all([
      sections.testimonials ? this.loadTestimonials(tenant.id) : Promise.resolve([]),
      sections.faq ? this.loadFaqs(tenant.id) : Promise.resolve([]),
      this.loadActivePromotion(tenant.id),
      hasWebPremium
        ? this.admin.blogPost.count({ where: { tenantId: tenant.id, isPublished: true } })
        : Promise.resolve(0),
    ]);

    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      customDomain: tenant.customDomainVerifiedAt ? tenant.customDomain : null,
      googleReviewUrl: tenant.googleReviewUrl,
      webTemplate,
      webHeadline: hasWebPremium ? tenant.webHeadline : null,
      webAbout: hasWebPremium ? tenant.webAbout : null,
      webContent: hasWebPremium ? parseWebContent(tenant.webContent) : null,
      testimonials,
      faqs,
      contactEnabled: sections.contact,
      activePromotion,
      hasBlog: blogCount > 0,
      facilities: facilities.map((f) => ({
        id: f.id,
        publicSlug: f.publicSlug,
        name: f.name,
        address: f.address,
        city: f.city,
        postalCode: f.postalCode,
        contactPhone: f.contactPhone,
        contactEmail: f.contactEmail,
        openingHours: (f.openingHours as OpeningHours) ?? {},
        timezone: f.timezone,
        latitude: f.latitude != null ? Number(f.latitude) : null,
        longitude: f.longitude != null ? Number(f.longitude) : null,
        imageUrls: (f.images ?? []).map((key) => this.files.buildPublicUrl('public', key)),
        videoUrl: f.videoUrl,
        // Se incluyen también los tipos sin disponibilidad (available:0) —
        // el frontend los muestra como "Agotado" en vez de ocultarlos, para
        // no dar la falsa impresión de que ese tamaño no existe.
        unitTypes: unitTypes.map((t) => ({
          id: t.id,
          name: t.name,
          available: availByFacilityType.get(`${f.id}:${t.id}`) ?? 0,
          priceMonthly: Number(t.defaultPriceMonthly),
          areaM2: areaByFacilityType.get(`${f.id}:${t.id}`) ?? null,
        })),
      })),
    };
  }

  /** ¿El tenant tiene la feature `web_premium` (plan + overrides)? */
  private async hasWebPremium(tenantId: string): Promise<boolean> {
    const [subscription, overrides] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId },
        select: { feature: true, enabled: true },
      }),
    ]);
    const base = subscription ? resolvePlanFeatures(subscription.plan) : [];
    const features = effectiveFeaturesFromList(
      base,
      overrides as { feature: TenantFeature; enabled: boolean }[],
    );
    return features.includes('web_premium');
  }

  /** Testimonios: reseñas enviadas, promotoras (NPS ≥ 9) y con comentario. */
  private async loadTestimonials(tenantId: string): Promise<PublicTestimonialDto[]> {
    const rows = await this.admin.review.findMany({
      where: {
        tenantId,
        status: 'submitted',
        npsScore: { gte: 9 },
        comment: { not: null },
      },
      select: {
        comment: true,
        rating: true,
        customer: { select: { firstName: true, lastName: true, companyName: true } },
      },
      orderBy: { submittedAt: 'desc' },
      take: 6,
    });
    return rows
      .filter((r) => (r.comment ?? '').trim().length > 0)
      .map((r) => {
        const first = r.customer?.firstName?.trim() ?? '';
        const lastInitial = r.customer?.lastName?.trim()?.[0];
        // Anonimizado a «Nombre A.» (o razón social) para no exponer el apellido.
        const author =
          first || lastInitial
            ? [first, lastInitial ? `${lastInitial}.` : ''].filter(Boolean).join(' ')
            : (r.customer?.companyName ?? 'Cliente');
        return { author, comment: r.comment!.trim(), rating: r.rating };
      });
  }

  /** FAQ publicadas del centro de ayuda del negocio. */
  private async loadFaqs(tenantId: string): Promise<PublicFaqDto[]> {
    const rows = await this.admin.faqEntry.findMany({
      where: { tenantId, isPublished: true },
      select: { question: true, answer: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: 20,
    });
    return rows.map((r) => ({ question: r.question, answer: r.answer }));
  }

  /**
   * Promoción activa y usable AHORA MISMO (dentro de su ventana de fechas y sin
   * agotar sus usos), para el banner de la web pública. Base para todos los
   * tenants (no gateada por `web_premium`): es la misma info que cualquier
   * comercial daría por teléfono, no un extra de marketing. Si hay varias, se
   * destaca la creada más recientemente.
   */
  private async loadActivePromotion(tenantId: string): Promise<PublicActivePromotionDto | null> {
    const now = new Date();
    const candidates = await this.admin.promotion.findMany({
      where: {
        tenantId,
        isActive: true,
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        ],
      },
      select: {
        code: true,
        name: true,
        discountType: true,
        discountValue: true,
        maxUses: true,
        usedCount: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const promo = candidates.find((p) => p.maxUses == null || p.usedCount < p.maxUses);
    if (!promo) return null;
    return {
      code: promo.code,
      name: promo.name,
      discountType: promo.discountType,
      discountValue: Number(promo.discountValue),
    };
  }

  /**
   * Formulario de contacto de la web pública → crea un lead (source `web`). Solo
   * si el tenant tiene la feature `web_premium` y la sección de contacto activa.
   */
  async submitContact(
    slug: string,
    input: PublicContactInput,
    meta: RequestMeta,
  ): Promise<LeadDto> {
    if (input.hp) {
      throw new NotFoundException({ code: 'invalid_payload', message: 'Solicitud invalida' });
    }
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const sections = (await this.hasWebPremium(tenant.id))
      ? parseWebSections(tenant.webSections)
      : { testimonials: false, faq: false, contact: false };
    if (!sections.contact) {
      throw new NotFoundException({ code: 'contact_disabled', message: 'No disponible' });
    }
    return this.leads.createFromWebContact({
      tenantId: tenant.id,
      input: {
        firstName: input.firstName,
        lastName: input.lastName || undefined,
        email: input.email,
        phone: input.phone || undefined,
        message: input.message || undefined,
      },
      meta,
    });
  }

  /**
   * Marca del operador por slug (ligero): nombre + color + logo. La usa el login
   * del inquilino para verse con el aspecto white-label del tenant. El color y el
   * logo NO se gatean por `web_premium` (son parte del white-label base).
   */
  async getBrand(slug: string): Promise<PublicTenantBrandDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: {
        name: true,
        slug: true,
        portalBrandColor: true,
        portalLogoUrl: true,
        deletedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
    };
  }

  /** Landing de un único local por su `publicSlug`. */
  async getFacilityBySlug(
    tenantSlug: string,
    facilitySlug: string,
  ): Promise<PublicFacilityLandingDto> {
    const full = await this.getBySlug(tenantSlug);
    const facility = full.facilities.find(
      (f: PublicLandingFacilityDto) => f.publicSlug === facilitySlug,
    );
    if (!facility) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'No encontrado' });
    }
    return {
      tenantName: full.tenantName,
      tenantSlug: full.tenantSlug,
      brandColor: full.brandColor,
      logoUrl: full.logoUrl,
      customDomain: full.customDomain,
      hasBlog: full.hasBlog,
      facility,
    };
  }

  /**
   * Resuelve un dominio propio ACTIVO (verificado) → slug del tenant. Lo
   * consume el middleware del web para reescribir `midominio.com/` a la landing
   * del tenant. 404 si el host no está registrado y verificado.
   */
  async resolveDomain(host: string): Promise<ResolveDomainDto> {
    const domain = host.trim().toLowerCase();
    if (!isValidCustomDomain(domain)) {
      throw new NotFoundException({ code: 'domain_not_found', message: 'No encontrado' });
    }
    const tenant = await this.admin.tenant.findFirst({
      where: { customDomain: domain, customDomainVerifiedAt: { not: null }, deletedAt: null },
      select: { slug: true, webTemplate: true, externalSiteUrl: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'domain_not_found', message: 'No encontrado' });
    }
    return {
      tenantSlug: tenant.slug,
      hasExternalSite: tenant.webTemplate === 'external' && tenant.externalSiteUrl != null,
    };
  }

  /**
   * URL base de la web externa del tenant (ligero, solo para la ruta de proxy
   * `/tenant-site/<slug>` del web) — SIN las consultas de `getBySlug`
   * (facilities/testimonios/FAQ), que no hacen falta para cada asset. 404 si
   * el tenant no existe, no usa la plantilla `external`, o no tiene URL.
   */
  async getExternalSite(slug: string): Promise<ExternalSiteDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: { webTemplate: true, externalSiteUrl: true, deletedAt: true },
    });
    if (
      !tenant ||
      tenant.deletedAt ||
      tenant.webTemplate !== 'external' ||
      !tenant.externalSiteUrl
    ) {
      throw new NotFoundException({ code: 'external_site_not_found', message: 'No encontrado' });
    }
    return { baseUrl: tenant.externalSiteUrl };
  }

  /**
   * URLs indexables para el sitemap: tenants activos (con suscripción no
   * cancelada) + los slugs de sus locales activos + los de sus entradas de
   * blog publicadas. Nota: expone los slugs públicos de todos los tenants en
   * el dominio compartido (las landings ya son públicas); si se quiere por
   * dominio propio, filtrar aquí. Los slugs de blog no se filtran por
   * `web_premium` (solo puede haber posts publicados si el tenant tiene la
   * feature al escribirlos; si la pierde después, el edge case de un slug
   * huérfano en el sitemap es menor — el endpoint público 404 igualmente).
   */
  async sitemap(): Promise<PublicSitemapDto> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, status: { in: ['trial', 'active'] } },
      select: { slug: true, updatedAt: true },
    });
    if (tenants.length === 0) return { entries: [] };

    const [facilities, blogPosts] = await Promise.all([
      this.admin.facility.findMany({
        where: { deletedAt: null, isActive: true, publicSlug: { not: null } },
        select: { publicSlug: true, tenant: { select: { slug: true } } },
      }),
      this.admin.blogPost.findMany({
        where: { isPublished: true },
        select: { slug: true, tenant: { select: { slug: true } } },
      }),
    ]);
    const bySlug = new Map<string, string[]>();
    for (const f of facilities) {
      if (!f.publicSlug) continue;
      const list = bySlug.get(f.tenant.slug) ?? [];
      list.push(f.publicSlug);
      bySlug.set(f.tenant.slug, list);
    }
    const blogByTenant = new Map<string, string[]>();
    for (const p of blogPosts) {
      const list = blogByTenant.get(p.tenant.slug) ?? [];
      list.push(p.slug);
      blogByTenant.set(p.tenant.slug, list);
    }

    return {
      entries: tenants.map((t) => ({
        tenantSlug: t.slug,
        updatedAt: t.updatedAt.toISOString(),
        facilitySlugs: bySlug.get(t.slug) ?? [],
        blogPostSlugs: blogByTenant.get(t.slug) ?? [],
      })),
    };
  }

  /** Tenant + marca, exige la feature `web_premium` — usado por el blog público. */
  private async requireBlogTenant(slug: string): Promise<{
    id: string;
    name: string;
    slug: string;
    brandColor: string | null;
    logoUrl: string | null;
    customDomain: string | null;
  }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        slug: true,
        deletedAt: true,
        portalBrandColor: true,
        portalLogoUrl: true,
        customDomain: true,
        customDomainVerifiedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    if (!(await this.hasWebPremium(tenant.id))) {
      throw new NotFoundException({ code: 'blog_not_available', message: 'No encontrado' });
    }
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      customDomain: tenant.customDomainVerifiedAt ? tenant.customDomain : null,
    };
  }

  /** Entradas de blog publicadas del tenant (`/s/<slug>/blog`). */
  async listBlogPosts(slug: string): Promise<PublicBlogListDto> {
    const tenant = await this.requireBlogTenant(slug);
    const rows = await this.admin.blogPost.findMany({
      where: { tenantId: tenant.id, isPublished: true },
      select: {
        slug: true,
        title: true,
        excerpt: true,
        coverImageKey: true,
        publishedAt: true,
      },
      orderBy: { publishedAt: 'desc' },
      take: 100,
    });
    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.brandColor,
      logoUrl: tenant.logoUrl,
      customDomain: tenant.customDomain,
      posts: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        excerpt: r.excerpt,
        coverImageUrl: r.coverImageKey
          ? this.files.buildPublicUrl('public', r.coverImageKey)
          : null,
        // `isPublished:true` siempre trae `publishedAt` (se fija al publicar).
        publishedAt: r.publishedAt!.toISOString(),
      })),
    };
  }

  /** Una entrada de blog publicada por su slug (`/s/<slug>/blog/<postSlug>`). */
  async getBlogPost(slug: string, postSlug: string): Promise<PublicBlogPostDto> {
    const tenant = await this.requireBlogTenant(slug);
    const row = await this.admin.blogPost.findFirst({
      where: { tenantId: tenant.id, slug: postSlug, isPublished: true },
    });
    if (!row) {
      throw new NotFoundException({ code: 'blog_post_not_found', message: 'No encontrado' });
    }
    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.brandColor,
      logoUrl: tenant.logoUrl,
      customDomain: tenant.customDomain,
      post: {
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        contentMarkdown: row.contentMarkdown,
        coverImageUrl: row.coverImageKey
          ? this.files.buildPublicUrl('public', row.coverImageKey)
          : null,
        seoTitle: row.seoTitle,
        seoDescription: row.seoDescription,
        publishedAt: row.publishedAt!.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }
}
