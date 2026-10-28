import { Injectable, NotFoundException } from '@nestjs/common';
import {
  SUSPENSION_WEB_OFFLINE_DAYS,
  suspensionDays,
  areaPageLinks,
  cityPageOfFacility,
  cityPageReplacingFacility,
  resolveAreaPages,
  couponSummary,
  effectiveFeaturesFromList,
  promoLandingIsLive,
  isValidCustomDomain,
  isWebTemplate,
  parseWebContent,
  parseWebSeo,
  parseWebSections,
  rentTax,
  resolvePlanFeatures,
  waMeNumber,
} from '@storageos/shared';

import { tenantHasFeature, liveOverrideWhere } from '../../common/tenant-features';
import { toAreaContent } from '../area-pages/area-page.mapper';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';
import { LeadsService } from '../leads/leads.service';
import { promotionUnitId } from '../promotions/promotions.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  PublicAreaPageContentDto,
  LeadDto,
  OpeningHours,
  PublicContactInput,
  PromoVisitInput,
  PublicFaqDto,
  PublicTestimonialDto,
  TenantFeature,
} from '@storageos/shared';
import type {
  ExternalSiteDto,
  PublicActivePromotionDto,
  PublicBlogFacilityLinkDto,
  PublicBlogListDto,
  PublicBlogPostDto,
  PublicFacilityLandingDto,
  PublicLandingDto,
  PublicLandingFacilityDto,
  PublicPromoPageDto,
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

  /**
   * Landing de promoción en vigor (`/promo/<slug>`, extra Web Premium) junto a
   * los datos de la web (marca, plantilla, locales y precios). Apagada,
   * caducada o inexistente → 404 (la web lleva a la portada).
   */
  async getPromo(slug: string, promoSlug: string): Promise<PublicPromoPageDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt || !(await this.hasWebPremium(tenant.id))) {
      throw new NotFoundException({ code: 'promo_not_available', message: 'No encontrado' });
    }
    const promo = await this.admin.promoLanding.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug: promoSlug.toLowerCase() } },
      include: { coupon: true },
    });
    if (!promo || !promoLandingIsLive(promo)) {
      throw new NotFoundException({ code: 'promo_not_available', message: 'No encontrado' });
    }
    const now = new Date();
    const c = promo.coupon;
    const couponUsable =
      !!c &&
      c.isActive &&
      (!c.validFrom || c.validFrom <= now) &&
      (!c.validUntil || c.validUntil > now) &&
      (c.maxUses === null || c.usedCount < c.maxUses);
    const site = await this.getBySlug(slug);
    return {
      site,
      promo: {
        slug: promo.slug,
        headline: promo.headline,
        subheadline: promo.subheadline,
        offerText: promo.offerText,
        body: promo.body,
        benefits: promo.benefits,
        conditions: promo.conditions,
        ctaLabel: promo.ctaLabel,
        heroImageUrl: promo.heroImageKey
          ? this.files.buildPublicUrl('public', promo.heroImageKey)
          : null,
        endsAt: promo.endsAt?.toISOString() ?? null,
        showCountdown: promo.showCountdown,
        showTestimonials: promo.showTestimonials,
        showFaq: promo.showFaq,
        showContact: promo.showContact,
        seoTitle: promo.seoTitle,
        seoDescription: promo.seoDescription,
        indexable: promo.indexable,
        coupon:
          couponUsable && c
            ? {
                code: c.code,
                summary: couponSummary({
                  discountType: c.discountType,
                  discountValue: Number(c.discountValue),
                  minMonths: c.minMonths,
                }),
                minMonths: c.minMonths,
              }
            : null,
        facilityIds: promo.facilityIds,
        unitTypeIds: promo.unitTypeIds,
      },
    };
  }

  /**
   * Visita a una landing en vigor (la manda la página al abrirse). Un mismo
   * visitante cuenta una vez cada 30 minutos por landing (recargas, volver
   * atrás). Sin IP ni datos personales.
   */
  async recordPromoVisit(slug: string, promoSlug: string, input: PromoVisitInput): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) return;
    const promo = await this.admin.promoLanding.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug: promoSlug.toLowerCase() } },
      select: { id: true, isActive: true, startsAt: true, endsAt: true },
    });
    if (!promo || !promoLandingIsLive(promo)) return;
    const recent = await this.admin.promoLandingVisit.findFirst({
      where: {
        promoLandingId: promo.id,
        visitorId: input.visitorId,
        createdAt: { gte: new Date(Date.now() - 30 * 60_000) },
      },
      select: { id: true },
    });
    if (recent) return;
    const clean = (v: string | undefined) => (v ? v.toLowerCase() : null);
    await this.admin.promoLandingVisit.create({
      data: {
        tenantId: tenant.id,
        promoLandingId: promo.id,
        visitorId: input.visitorId,
        source: clean(input.source),
        medium: clean(input.medium),
        campaign: clean(input.campaign),
      },
    });
  }

  async getBySlug(slug: string): Promise<PublicLandingDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }

    const [facilities, unitTypes, grouped, allGrouped] = await Promise.all([
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
          preOpening: true,
          openingDate: true,
        },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, defaultPriceMonthly: true, propertyKind: true },
      }),
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id, status: 'available' },
        _count: { _all: true },
        _avg: { areaM2: true },
        _min: { basePriceMonthly: true },
      }),
      // Todos los trasteros (cualquier estado): qué tamaños tiene cada local.
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId: tenant.id },
        _avg: { areaM2: true },
        _min: { basePriceMonthly: true },
      }),
    ]);

    const round1 = (v: unknown) => (v != null ? Math.round(Number(v) * 10) / 10 : null);
    const availByFacilityType = new Map<string, number>();
    const areaByFacilityType = new Map<string, number | null>();
    const minPriceByFacilityType = new Map<string, number>();
    for (const g of grouped) {
      const key = `${g.facilityId}:${g.unitTypeId}`;
      availByFacilityType.set(key, g._count._all);
      areaByFacilityType.set(key, round1(g._avg.areaM2));
      if (g._min.basePriceMonthly != null) {
        minPriceByFacilityType.set(key, Number(g._min.basePriceMonthly));
      }
    }
    // Tamaños agotados: el m² y el precio salen de todos sus trasteros.
    const existingFacilityType = new Set<string>();
    for (const g of allGrouped) {
      const key = `${g.facilityId}:${g.unitTypeId}`;
      existingFacilityType.add(key);
      if (!areaByFacilityType.get(key)) areaByFacilityType.set(key, round1(g._avg.areaM2));
      if (!minPriceByFacilityType.has(key) && g._min.basePriceMonthly != null) {
        minPriceByFacilityType.set(key, Number(g._min.basePriceMonthly));
      }
    }

    // Web Premium: solo si el tenant tiene la feature se aplica la plantilla y los
    // textos personalizados; si no, se sirve `default` sin headline/about custom.
    const hasWebPremium = await this.hasWebPremium(tenant.id);
    // Texto propio de las páginas de zona y zonas cercanas: extra «SEO local».
    const areaPages = (await tenantHasFeature(this.admin, tenant.id, 'local_seo'))
      ? ((await this.areaContents([tenant.id])).get(tenant.id) ?? [])
      : [];
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
    const [testimonials, faqs, activePromotion, latestPosts] = await Promise.all([
      sections.testimonials ? this.loadTestimonials(tenant.id) : Promise.resolve([]),
      sections.faq ? this.loadFaqs(tenant.id) : Promise.resolve([]),
      this.loadActivePromotion(tenant.id),
      hasWebPremium
        ? this.admin.blogPost.findMany({
            where: { tenantId: tenant.id, isPublished: true },
            select: {
              slug: true,
              title: true,
              excerpt: true,
              coverImageKey: true,
              publishedAt: true,
            },
            orderBy: { publishedAt: 'desc' },
            take: 4,
          })
        : Promise.resolve([]),
    ]);

    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      customDomain: tenant.customDomainVerifiedAt ? tenant.customDomain : null,
      googleReviewUrl: tenant.googleReviewUrl,
      googleSiteVerification: tenant.googleSiteVerification,
      googleAnalyticsId: tenant.googleAnalyticsId,
      webTemplate,
      webHeaderBranded: tenant.webHeaderBranded,
      webHeadline: hasWebPremium ? tenant.webHeadline : null,
      webAbout: hasWebPremium ? tenant.webAbout : null,
      webContent: hasWebPremium ? parseWebContent(tenant.webContent) : null,
      webSeo: hasWebPremium ? parseWebSeo(tenant.webSeo) : null,
      areaPages,
      areaLinks: areaPageLinks(
        resolveAreaPages(
          facilities.map((f) => ({ id: f.id, city: f.city, publicSlug: f.publicSlug })),
          areaPages,
        ),
      ),
      whatsappNumber: await this.whatsappNumber(tenant.id),
      testimonials,
      faqs,
      faqEnabled: !hasWebPremium || sections.faq,
      contactEnabled: sections.contact,
      activePromotion,
      hasBlog: latestPosts.length > 0,
      latestBlogPosts: latestPosts.map((r) => ({
        slug: r.slug,
        title: r.title,
        excerpt: r.excerpt,
        coverImageUrl: r.coverImageKey
          ? this.files.buildPublicUrl('public', r.coverImageKey)
          : null,
        publishedAt: r.publishedAt!.toISOString(),
      })),
      facilities: facilities.map((f) => ({
        id: f.id,
        publicSlug: f.publicSlug,
        name: f.name,
        address: f.address,
        city: f.city,
        postalCode: f.postalCode,
        // Sin contacto propio del local, el del negocio.
        contactPhone: f.contactPhone ?? tenant.contactPhone,
        contactEmail: f.contactEmail ?? tenant.contactEmail,
        openingHours: (f.openingHours as OpeningHours) ?? {},
        timezone: f.timezone,
        latitude: f.latitude != null ? Number(f.latitude) : null,
        longitude: f.longitude != null ? Number(f.longitude) : null,
        imageUrls: (f.images ?? []).map((key) => this.files.buildPublicUrl('public', key)),
        videoUrl: f.videoUrl,
        preOpening: f.preOpening,
        openingDate: f.openingDate ? f.openingDate.toISOString().slice(0, 10) : null,
        // Solo los tamaños que tiene ESTE local; los que tiene pero están
        // llenos salen con available:0 ("Agotado", con lista de espera).
        // Precio = el del trastero más barato disponible de ese tamaño (es el
        // que se asigna al reservar); agotado, el más barato que tenga.
        unitTypes: unitTypes
          .filter((t) => existingFacilityType.has(`${f.id}:${t.id}`))
          .map((t) => ({
            id: t.id,
            name: t.name,
            available: availByFacilityType.get(`${f.id}:${t.id}`) ?? 0,
            priceMonthly:
              minPriceByFacilityType.get(`${f.id}:${t.id}`) ?? Number(t.defaultPriceMonthly),
            taxRate: rentTax(t.propertyKind).taxRate,
            areaM2: areaByFacilityType.get(`${f.id}:${t.id}`) ?? null,
          })),
      })),
    };
  }

  /** ¿El tenant tiene la feature `web_premium` (plan + overrides)? */
  /**
   * Número del WhatsApp Business del tenant para el botón de la web: con el
   * extra, el número activo y el botón activado (independiente de Web Premium).
   */
  private async whatsappNumber(tenantId: string): Promise<string | null> {
    const row = await this.admin.tenantWhatsappSettings.findUnique({
      where: { tenantId },
      select: { enabled: true, webButtonEnabled: true, displayPhone: true },
    });
    if (!row?.enabled || !row.webButtonEnabled) return null;
    if (!(await tenantHasFeature(this.admin, tenantId, 'whatsapp_business'))) return null;
    return waMeNumber(row.displayPhone);
  }

  /** Páginas de zona publicadas de cada tenant (con texto propio). */
  private async areaContents(
    tenantIds: string[],
  ): Promise<Map<string, PublicAreaPageContentDto[]>> {
    const out = new Map<string, PublicAreaPageContentDto[]>();
    if (tenantIds.length === 0) return out;
    const rows = await this.admin.webAreaPage.findMany({
      where: { tenantId: { in: tenantIds }, isPublished: true },
      orderBy: { name: 'asc' },
    });
    for (const r of rows) {
      const list = out.get(r.tenantId) ?? [];
      list.push(toAreaContent(r));
      out.set(r.tenantId, list);
    }
    return out;
  }

  private async hasWebPremium(tenantId: string): Promise<boolean> {
    const [subscription, overrides] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId, ...liveOverrideWhere() },
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

  /** Testimonios: valoraciones con comentario que el equipo ha publicado. */
  private async loadTestimonials(tenantId: string): Promise<PublicTestimonialDto[]> {
    const rows = await this.admin.review.findMany({
      where: {
        tenantId,
        status: 'submitted',
        // Solo las que el equipo ha elegido publicar.
        publishedOnWeb: true,
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
        // Nunca las recompensas personales de un referido (código de un solo
        // uso de otra persona): la web las anunciaría a todo el mundo.
        referrals: { none: {} },
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
        ],
      },
      select: {
        appliesTo: true,
        code: true,
        name: true,
        discountType: true,
        discountValue: true,
        maxUses: true,
        usedCount: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    // Tampoco las ofertas de un trastero concreto: solo valen para ese trastero.
    const promo = candidates.find(
      (p) =>
        promotionUnitId(p.appliesTo) === null && (p.maxUses == null || p.usedCount < p.maxUses),
    );
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
        acceptsMarketing: input.acceptsMarketing ?? false,
        utmSource: input.utmSource,
        utmMedium: input.utmMedium,
        utmCampaign: input.utmCampaign,
      },
      meta,
    });
  }

  /**
   * Marca del operador por slug (ligero): nombre + color + logo. La usa el login
   * del inquilino para verse con el aspecto white-label del tenant. El color y el
   * logo NO se gatean por `web_premium` (son parte del white-label base).
   */
  /** Suspendido desde hace 15 días o más: su web deja de verse. */
  private webOffline(t: { canceledAt: Date | null; updatedAt: Date }): boolean {
    return suspensionDays(t.canceledAt ?? t.updatedAt) >= SUSPENSION_WEB_OFFLINE_DAYS;
  }

  async getBrand(slug: string): Promise<PublicTenantBrandDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: {
        name: true,
        slug: true,
        portalBrandColor: true,
        portalLogoUrl: true,
        portalLogoKey: true,
        webFaviconKey: true,
        deletedAt: true,
        id: true,
        status: true,
        canceledAt: true,
        contactPhone: true,
        contactEmail: true,
        updatedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const suspended = tenant.status === 'suspended';
    const contact = suspended
      ? await this.admin.facility.findFirst({
          where: {
            tenantId: tenant.id,
            deletedAt: null,
            isActive: true,
            OR: [{ contactPhone: { not: null } }, { contactEmail: { not: null } }],
          },
          select: { contactPhone: true, contactEmail: true },
          orderBy: { createdAt: 'asc' },
        })
      : null;
    return {
      portalUnavailable: suspended,
      webUnavailable: suspended && this.webOffline(tenant),
      contactPhone: suspended ? (tenant.contactPhone ?? contact?.contactPhone ?? null) : null,
      contactEmail: suspended ? (tenant.contactEmail ?? contact?.contactEmail ?? null) : null,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      logoUploaded: tenant.portalLogoKey !== null,
      faviconUrl: tenant.webFaviconKey
        ? this.files.buildPublicUrl('public', tenant.webFaviconKey)
        : null,
    };
  }

  /**
   * Bytes del logo subido por el tenant (para dibujar el icono de su app). Solo
   * el subido: una dirección pegada nunca se descarga desde el servidor.
   */
  async getUploadedLogo(slug: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: { portalLogoKey: true, deletedAt: true },
    });
    const key = tenant && !tenant.deletedAt ? tenant.portalLogoKey : null;
    if (!key) throw new NotFoundException({ code: 'logo_not_found', message: 'Sin logo' });
    const bytes = await this.files.getObject({ bucket: 'public', key });
    return { bytes, mimeType: key.endsWith('.jpg') ? 'image/jpeg' : 'image/png' };
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
      webTemplate: full.webTemplate,
      webHeaderBranded: full.webHeaderBranded,
      hasBlog: full.hasBlog,
      googleAnalyticsId: full.googleAnalyticsId,
      whatsappNumber: full.whatsappNumber,
      facility,
      ...(() => {
        const pages = resolveAreaPages(full.facilities, full.areaPages);
        const city = cityPageOfFacility(pages, facility.id);
        // Su ciudad solo tiene este local: la página de la ciudad muestra esta
        // ficha y la ficha redirige a ella.
        const own = cityPageReplacingFacility(pages, facility.id);
        return {
          cityPage: city ? { name: city.name, slug: city.slug } : null,
          areaPage: own ? { name: own.name, slug: own.slug, content: own.content } : null,
          singleFacility: full.facilities.length === 1,
          areaLinks: full.areaLinks,
        };
      })(),
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
      select: { id: true, slug: true, webTemplate: true, externalSiteUrl: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'domain_not_found', message: 'No encontrado' });
    }
    // Igual que `getBySlug`: si el tenant perdió `web_premium` (downgrade,
    // quitar el override, impago que suspende features) el proxy de web
    // externa deja de activarse — sin esto seguía sirviendo indefinidamente
    // sin volver a pagar el add-on.
    const hasExternalSite =
      tenant.webTemplate === 'external' &&
      tenant.externalSiteUrl != null &&
      (await this.hasWebPremium(tenant.id));
    return { tenantSlug: tenant.slug, hasExternalSite };
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
      select: {
        id: true,
        webTemplate: true,
        externalSiteUrl: true,
        deletedAt: true,
        status: true,
        canceledAt: true,
        updatedAt: true,
      },
    });
    if (
      !tenant ||
      tenant.deletedAt ||
      (tenant.status === 'suspended' && this.webOffline(tenant)) ||
      tenant.webTemplate !== 'external' ||
      !tenant.externalSiteUrl
    ) {
      throw new NotFoundException({ code: 'external_site_not_found', message: 'No encontrado' });
    }
    // Mismo gating que `resolveDomain`/`getBySlug`: sin `web_premium` el proxy
    // no debe seguir sirviendo la web externa aunque quede configurada en BD.
    if (!(await this.hasWebPremium(tenant.id))) {
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
      select: { slug: true, updatedAt: true, customDomain: true, customDomainVerifiedAt: true },
    });
    if (tenants.length === 0) return { entries: [] };

    const [facilities, blogPosts, promos] = await Promise.all([
      this.admin.facility.findMany({
        where: { deletedAt: null, isActive: true },
        select: {
          id: true,
          publicSlug: true,
          city: true,
          tenantId: true,
          tenant: { select: { slug: true } },
        },
      }),
      this.admin.blogPost.findMany({
        where: { isPublished: true },
        select: { slug: true, updatedAt: true, tenantId: true, tenant: { select: { slug: true } } },
      }),
      this.admin.promoLanding.findMany({
        where: { indexable: true, isActive: true },
        select: {
          slug: true,
          isActive: true,
          startsAt: true,
          endsAt: true,
          tenantId: true,
          tenant: { select: { slug: true } },
        },
      }),
    ]);
    const bySlug = new Map<string, string[]>();
    const facilitiesByTenant = new Map<
      string,
      { id: string; city: string | null; publicSlug: string | null; tenantId: string }[]
    >();
    for (const f of facilities) {
      const all = facilitiesByTenant.get(f.tenant.slug) ?? [];
      all.push(f);
      facilitiesByTenant.set(f.tenant.slug, all);
      if (!f.publicSlug) continue;
      const list = bySlug.get(f.tenant.slug) ?? [];
      list.push(f.publicSlug);
      bySlug.set(f.tenant.slug, list);
    }
    // El blog y las landings solo se sirven con Web Premium: sin él no se listan.
    const premium = new Map<string, boolean>();
    const hasPremium = async (tenantId: string) => {
      if (!premium.has(tenantId)) premium.set(tenantId, await this.hasWebPremium(tenantId));
      return premium.get(tenantId)!;
    };
    const blogByTenant = new Map<string, { slug: string; updatedAt: string }[]>();
    for (const p of blogPosts) {
      if (!(await hasPremium(p.tenantId))) continue;
      const list = blogByTenant.get(p.tenant.slug) ?? [];
      list.push({ slug: p.slug, updatedAt: p.updatedAt.toISOString() });
      blogByTenant.set(p.tenant.slug, list);
    }
    const promosByTenant = new Map<string, string[]>();
    for (const p of promos) {
      if (!promoLandingIsLive(p) || !(await hasPremium(p.tenantId))) continue;
      const list = promosByTenant.get(p.tenant.slug) ?? [];
      list.push(p.slug);
      promosByTenant.set(p.tenant.slug, list);
    }

    // Páginas de zona con texto propio: solo con «SEO local» (como en la web).
    const seoTenantIds: string[] = [];
    for (const tenantId of new Set(facilities.map((f) => f.tenantId))) {
      if (await tenantHasFeature(this.admin, tenantId, 'local_seo')) seoTenantIds.push(tenantId);
    }
    const areaByTenant = await this.areaContents(seoTenantIds);

    return {
      entries: tenants.map((t) => {
        const posts = blogByTenant.get(t.slug) ?? [];
        return {
          tenantSlug: t.slug,
          updatedAt: t.updatedAt.toISOString(),
          ...(() => {
            const own = facilitiesByTenant.get(t.slug) ?? [];
            const tenantId = own[0]?.tenantId;
            const pages = resolveAreaPages(own, (tenantId && areaByTenant.get(tenantId)) || []);
            // Con un solo local su ficha apunta a la portada, y la del único
            // local de una ciudad, a la página de la ciudad: no van al sitemap.
            const replaced = new Set(
              pages.flatMap((p) => (p.soleFacility?.publicSlug ? [p.soleFacility.publicSlug] : [])),
            );
            return {
              facilitySlugs:
                own.length > 1 ? (bySlug.get(t.slug) ?? []).filter((s) => !replaced.has(s)) : [],
              citySlugs: pages.filter((p) => p.indexable).map((p) => p.slug),
            };
          })(),
          blogPostSlugs: posts.map((p) => p.slug),
          blogPosts: posts,
          promoSlugs: promosByTenant.get(t.slug) ?? [],
          customDomain: t.customDomainVerifiedAt ? t.customDomain : null,
        };
      }),
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
    googleAnalyticsId: string | null;
    webTemplate: string;
    webHeaderBranded: boolean;
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
        googleAnalyticsId: true,
        webTemplate: true,
        webHeaderBranded: true,
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
      googleAnalyticsId: tenant.googleAnalyticsId,
      // El blog ya exige Web Premium: la plantilla elegida vale tal cual (salvo `external`).
      webTemplate:
        isWebTemplate(tenant.webTemplate) && tenant.webTemplate !== 'external'
          ? tenant.webTemplate
          : 'default',
      webHeaderBranded: tenant.webHeaderBranded,
    };
  }

  /**
   * Locales enlazables del tenant (con `publicSlug`) + su precio más bajo
   * disponible — enlazado interno del blog hacia las páginas que convierten.
   */
  private async loadFacilityLinks(tenantId: string): Promise<PublicBlogFacilityLinkDto[]> {
    const [facilities, unitTypes, grouped] = await Promise.all([
      this.admin.facility.findMany({
        where: { tenantId, deletedAt: null, isActive: true, publicSlug: { not: null } },
        select: { id: true, publicSlug: true, name: true, city: true },
        orderBy: { name: 'asc' },
      }),
      this.admin.unitType.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, propertyKind: true },
      }),
      // Precio del trastero más barato disponible de cada tamaño y local.
      this.admin.unit.groupBy({
        by: ['facilityId', 'unitTypeId'],
        where: { tenantId, status: 'available' },
        _min: { basePriceMonthly: true },
      }),
    ]);
    const taxById = new Map(unitTypes.map((t) => [t.id, rentTax(t.propertyKind).taxRate]));
    return facilities.map((f) => {
      let min: number | null = null;
      for (const g of grouped) {
        if (g.facilityId !== f.id || g._min.basePriceMonthly == null) continue;
        const tax = taxById.get(g.unitTypeId);
        if (tax === undefined) continue; // tipo inactivo
        const gross = Number(g._min.basePriceMonthly) * (1 + tax / 100);
        if (min === null || gross < min) min = gross;
      }
      return {
        publicSlug: f.publicSlug!,
        name: f.name,
        city: f.city,
        fromPriceMonthly: min !== null ? Math.round(min * 100) / 100 : null,
      };
    });
  }

  /** Entradas de blog publicadas del tenant (`/s/<slug>/blog`). */
  async listBlogPosts(slug: string): Promise<PublicBlogListDto> {
    const tenant = await this.requireBlogTenant(slug);
    const [rows, facilities] = await Promise.all([
      this.admin.blogPost.findMany({
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
      }),
      this.loadFacilityLinks(tenant.id),
    ]);
    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.brandColor,
      logoUrl: tenant.logoUrl,
      customDomain: tenant.customDomain,
      webTemplate: tenant.webTemplate,
      webHeaderBranded: tenant.webHeaderBranded,
      googleAnalyticsId: tenant.googleAnalyticsId,
      facilities,
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
    const [row, facilities] = await Promise.all([
      this.admin.blogPost.findFirst({
        where: { tenantId: tenant.id, slug: postSlug, isPublished: true },
      }),
      this.loadFacilityLinks(tenant.id),
    ]);
    if (!row) {
      throw new NotFoundException({ code: 'blog_post_not_found', message: 'No encontrado' });
    }
    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.brandColor,
      logoUrl: tenant.logoUrl,
      customDomain: tenant.customDomain,
      webTemplate: tenant.webTemplate,
      webHeaderBranded: tenant.webHeaderBranded,
      googleAnalyticsId: tenant.googleAnalyticsId,
      facilities,
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
