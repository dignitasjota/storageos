import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildTenantLegalDoc,
  missingLegalHolderData,
  parseWebLegal,
  TENANT_LEGAL_DOCS,
  TENANT_LEGAL_FIELD,
  TENANT_LEGAL_TITLES,
  type PublicLegalDocDto,
  type TenantLegalContext,
  type TenantLegalDoc,
  type UpdateWebLegalInput,
  type WebLegalSettingsDto,
} from '@storageos/shared';

import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

const TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  deletedAt: true,
  taxId: true,
  billingLegalName: true,
  billingAddress: true,
  billingCity: true,
  billingPostalCode: true,
  billingEmail: true,
  portalBrandColor: true,
  portalLogoUrl: true,
  customDomain: true,
  customDomainVerifiedAt: true,
  googleAnalyticsId: true,
  webChatEnabled: true,
  webLegal: true,
} satisfies Prisma.TenantSelect;

type LegalTenant = Prisma.TenantGetPayload<{ select: typeof TENANT_SELECT }>;

/**
 * Textos legales de la web pública del tenant: aviso legal (LSSI), privacidad
 * (RGPD), cookies y condiciones generales de contratación. Se generan con sus datos de facturación y cada uno se
 * puede sustituir por uno propio. Para todos los tenants (no es un extra:
 * cualquier web con formulario y reserva los necesita).
 */
@Injectable()
export class WebLegalService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getPublicDoc(slug: string, doc: TenantLegalDoc): Promise<PublicLegalDocDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { slug }, select: TENANT_SELECT });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const ctx = await this.context(tenant);
    const custom = parseWebLegal(tenant.webLegal)[TENANT_LEGAL_FIELD[doc]];
    return {
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      brandColor: tenant.portalBrandColor,
      logoUrl: tenant.portalLogoUrl,
      customDomain: this.customDomain(tenant),
      googleAnalyticsId: tenant.googleAnalyticsId,
      doc,
      title: TENANT_LEGAL_TITLES[doc],
      markdown: custom ?? buildTenantLegalDoc(doc, ctx),
    };
  }

  /** Texto que se publica ahora de un documento (propio o generado). */
  async effectiveDoc(
    tenantId: string,
    doc: TenantLegalDoc,
  ): Promise<{ title: string; markdown: string; url: string }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: TENANT_SELECT,
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    const custom = parseWebLegal(tenant.webLegal)[TENANT_LEGAL_FIELD[doc]];
    const markdown = custom ?? buildTenantLegalDoc(doc, await this.context(tenant));
    const domain = this.customDomain(tenant);
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    return {
      title: TENANT_LEGAL_TITLES[doc],
      markdown,
      url: domain ? `https://${domain}/${doc}` : `${base}/s/${tenant.slug}/${doc}`,
    };
  }

  async getSettings(tenantId: string): Promise<WebLegalSettingsDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: TENANT_SELECT,
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    const ctx = await this.context(tenant);
    const generated = Object.fromEntries(
      TENANT_LEGAL_DOCS.map((d) => [d, buildTenantLegalDoc(d, ctx)]),
    ) as Record<TenantLegalDoc, string>;
    return {
      texts: parseWebLegal(tenant.webLegal),
      generated,
      holder: ctx.holder,
      missing: missingLegalHolderData(ctx.holder),
    };
  }

  async updateSettings(args: {
    tenantId: string;
    userId: string;
    input: UpdateWebLegalInput;
  }): Promise<WebLegalSettingsDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: args.tenantId },
      select: { webLegal: true },
    });
    if (!tenant) throw new NotFoundException('Tenant no encontrado');
    const next: Record<string, string> = { ...parseWebLegal(tenant.webLegal) };
    for (const [k, v] of Object.entries(args.input)) {
      if (v === undefined) continue;
      if (v.trim()) next[k] = v;
      else delete next[k];
    }
    await this.admin.tenant.update({ where: { id: args.tenantId }, data: { webLegal: next } });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'tenant.web_legal_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { custom: Object.keys(next) },
    });
    return this.getSettings(args.tenantId);
  }

  private customDomain(t: LegalTenant): string | null {
    return t.customDomainVerifiedAt ? t.customDomain : null;
  }

  private async context(t: LegalTenant): Promise<TenantLegalContext> {
    const [facility, whatsapp, places, webChat] = await Promise.all([
      this.admin.facility.findFirst({
        where: { tenantId: t.id, deletedAt: null, isActive: true },
        orderBy: { name: 'asc' },
        select: { contactEmail: true, contactPhone: true },
      }),
      this.admin.tenantWhatsappSettings.findUnique({
        where: { tenantId: t.id },
        select: { enabled: true },
      }),
      this.admin.facility.findMany({
        where: { tenantId: t.id, deletedAt: null, isActive: true },
        orderBy: { name: 'asc' },
        select: { name: true, address: true, postalCode: true, city: true },
      }),
      t.webChatEnabled ? tenantHasFeature(this.admin, t.id, 'ai_assistant') : false,
    ]);
    const address = [
      t.billingAddress,
      [t.billingPostalCode, t.billingCity].filter(Boolean).join(' '),
    ]
      .filter((x) => x && x.trim())
      .join(', ');
    const domain = this.customDomain(t);
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    return {
      holder: {
        name: t.billingLegalName?.trim() || t.name,
        taxId: t.taxId,
        address: address || null,
        email: t.billingEmail ?? facility?.contactEmail ?? null,
        phone: facility?.contactPhone ?? null,
      },
      websiteUrl: domain ? `https://${domain}` : `${base}/s/${t.slug}`,
      analytics: !!t.googleAnalyticsId,
      whatsapp: !!whatsapp?.enabled,
      webChat,
      tradeName: t.name,
      // Dirección de cada local, para identificar los establecimientos.
      facilities: places
        .map((f) => {
          const where = [f.address, [f.postalCode, f.city].filter(Boolean).join(' ')]
            .filter((x) => x && x.trim())
            .join(', ');
          return where ? `${f.name}: ${where}` : '';
        })
        .filter(Boolean),
    };
  }
}
