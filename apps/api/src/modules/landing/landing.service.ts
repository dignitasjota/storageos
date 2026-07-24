import { Injectable, NotFoundException } from '@nestjs/common';
import {
  effectiveFeaturesFromList,
  isValidCustomDomain,
  isWebTemplate,
  parseWebSections,
  resolvePlanFeatures,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';
import { LeadsService } from '../leads/leads.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  LeadDto,
  PublicContactInput,
  PublicFaqDto,
  PublicTestimonialDto,
  TenantFeature,
} from '@storageos/shared';
import type {
  PublicFacilityLandingDto,
  PublicLandingDto,
  PublicLandingFacilityDto,
  PublicSitemapDto,
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
          images: true,
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
      }),
    ]);

    const availByFacilityType = new Map<string, number>();
    for (const g of grouped) {
      availByFacilityType.set(`${g.facilityId}:${g.unitTypeId}`, g._count._all);
    }

    // Web Premium: solo si el tenant tiene la feature se aplica la plantilla y los
    // textos personalizados; si no, se sirve `default` sin headline/about custom.
    const hasWebPremium = await this.hasWebPremium(tenant.id);
    const webTemplate =
      hasWebPremium && isWebTemplate(tenant.webTemplate) ? tenant.webTemplate : 'default';
    const sections = hasWebPremium
      ? parseWebSections(tenant.webSections)
      : { testimonials: false, faq: false, contact: false };
    const [testimonials, faqs] = await Promise.all([
      sections.testimonials ? this.loadTestimonials(tenant.id) : Promise.resolve([]),
      sections.faq ? this.loadFaqs(tenant.id) : Promise.resolve([]),
    ]);

    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      customDomain: tenant.customDomainVerifiedAt ? tenant.customDomain : null,
      webTemplate,
      webHeadline: hasWebPremium ? tenant.webHeadline : null,
      webAbout: hasWebPremium ? tenant.webAbout : null,
      testimonials,
      faqs,
      contactEnabled: sections.contact,
      facilities: facilities.map((f) => ({
        id: f.id,
        publicSlug: f.publicSlug,
        name: f.name,
        address: f.address,
        city: f.city,
        postalCode: f.postalCode,
        contactPhone: f.contactPhone,
        contactEmail: f.contactEmail,
        openingHours: (f.openingHours as Record<string, unknown>) ?? {},
        imageUrls: (f.images ?? []).map((key) => this.files.buildPublicUrl('public', key)),
        unitTypes: unitTypes
          .map((t) => ({
            id: t.id,
            name: t.name,
            available: availByFacilityType.get(`${f.id}:${t.id}`) ?? 0,
            priceMonthly: Number(t.defaultPriceMonthly),
          }))
          .filter((t) => t.available > 0),
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
   * Formulario de contacto de la web pública → crea un lead (source `web`). Solo
   * si el tenant tiene la feature `web_premium` y la sección de contacto activa.
   */
  async submitContact(slug: string, input: PublicContactInput, meta: RequestMeta): Promise<LeadDto> {
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
      select: { slug: true },
    });
    if (!tenant) {
      throw new NotFoundException({ code: 'domain_not_found', message: 'No encontrado' });
    }
    return { tenantSlug: tenant.slug };
  }

  /**
   * URLs indexables para el sitemap: tenants activos (con suscripción no
   * cancelada) + los slugs de sus locales activos. Nota: expone los slugs
   * públicos de todos los tenants en el dominio compartido (las landings ya
   * son públicas); si se quiere por dominio propio, filtrar aquí.
   */
  async sitemap(): Promise<PublicSitemapDto> {
    const tenants = await this.admin.tenant.findMany({
      where: { deletedAt: null, status: { in: ['trial', 'active'] } },
      select: { slug: true, updatedAt: true },
    });
    if (tenants.length === 0) return { entries: [] };

    const facilities = await this.admin.facility.findMany({
      where: { deletedAt: null, isActive: true, publicSlug: { not: null } },
      select: { publicSlug: true, tenant: { select: { slug: true } } },
    });
    const bySlug = new Map<string, string[]>();
    for (const f of facilities) {
      if (!f.publicSlug) continue;
      const list = bySlug.get(f.tenant.slug) ?? [];
      list.push(f.publicSlug);
      bySlug.set(f.tenant.slug, list);
    }

    return {
      entries: tenants.map((t) => ({
        tenantSlug: t.slug,
        updatedAt: t.updatedAt.toISOString(),
        facilitySlugs: bySlug.get(t.slug) ?? [],
      })),
    };
  }
}
