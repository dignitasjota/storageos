import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  effectiveFeaturesFromList,
  isWebTemplate,
  parseWebSections,
  resolvePlanFeatures,
} from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractTemplateDto,
  TenantAccessSettingsResponse,
  TenantBillingSettingsResponse,
  TenantBrandingResponse,
  TenantFeature,
  UpdateContractTemplateInput,
  TenantReferralSettingsResponse,
  TenantReviewsSettingsResponse,
  TenantSecuritySettingsResponse,
  UpdateTenantAccessSettingsInput,
  UpdateTenantBillingSettingsInput,
  UpdateTenantBrandingInput,
  UpdateTenantReferralSettingsInput,
  UpdateTenantReviewsSettingsInput,
  UpdateTenantSecuritySettingsInput,
  UpdateWebSettingsInput,
  WebSettingsResponse,
} from '@storageos/shared';

@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {}

  async getSecurity(tenantId: string): Promise<TenantSecuritySettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      requireTwoFactorForManagers: tenant.requireTwoFactorForManagers,
    };
  }

  async updateSecurity(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantSecuritySettingsInput;
    meta: RequestMeta;
  }): Promise<TenantSecuritySettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const prev = tenant.requireTwoFactorForManagers;
    const next = args.input.requireTwoFactorForManagers;

    if (prev === next) {
      return { requireTwoFactorForManagers: next };
    }

    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: { requireTwoFactorForManagers: next },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.security.require_2fa_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { from: prev, to: next },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return { requireTwoFactorForManagers: updated.requireTwoFactorForManagers };
  }

  private billingDto(tenant: {
    autoChargeOnIssue: boolean;
    autoIssueRecurring: boolean;
    lateFeeEnabled: boolean;
    lateFeeType: string;
    lateFeeValue: unknown;
    lateFeeGraceDays: number;
    autoChargeRetryEnabled: boolean;
    autoChargeRetryMax: number;
    autoChargeRetryIntervalDays: number;
  }): TenantBillingSettingsResponse {
    return {
      autoChargeOnIssue: tenant.autoChargeOnIssue,
      autoIssueRecurring: tenant.autoIssueRecurring,
      lateFeeEnabled: tenant.lateFeeEnabled,
      lateFeeType: tenant.lateFeeType as 'percentage' | 'fixed',
      lateFeeValue: Number(tenant.lateFeeValue),
      lateFeeGraceDays: tenant.lateFeeGraceDays,
      autoChargeRetryEnabled: tenant.autoChargeRetryEnabled,
      autoChargeRetryMax: tenant.autoChargeRetryMax,
      autoChargeRetryIntervalDays: tenant.autoChargeRetryIntervalDays,
    };
  }

  async getBilling(tenantId: string): Promise<TenantBillingSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return this.billingDto(tenant);
  }

  async updateBilling(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantBillingSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantBillingSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const { input } = args;
    const data: Record<string, string | number | boolean> = {};
    if (input.autoChargeOnIssue !== undefined) data.autoChargeOnIssue = input.autoChargeOnIssue;
    if (input.autoIssueRecurring !== undefined) data.autoIssueRecurring = input.autoIssueRecurring;
    if (input.lateFeeEnabled !== undefined) data.lateFeeEnabled = input.lateFeeEnabled;
    if (input.lateFeeType !== undefined) data.lateFeeType = input.lateFeeType;
    if (input.lateFeeValue !== undefined) data.lateFeeValue = input.lateFeeValue;
    if (input.lateFeeGraceDays !== undefined) data.lateFeeGraceDays = input.lateFeeGraceDays;
    if (input.autoChargeRetryEnabled !== undefined)
      data.autoChargeRetryEnabled = input.autoChargeRetryEnabled;
    if (input.autoChargeRetryMax !== undefined) data.autoChargeRetryMax = input.autoChargeRetryMax;
    if (input.autoChargeRetryIntervalDays !== undefined)
      data.autoChargeRetryIntervalDays = input.autoChargeRetryIntervalDays;

    if (Object.keys(data).length === 0) {
      return this.billingDto(tenant);
    }

    const updated = await this.admin.tenant.update({ where: { id: args.tenantId }, data });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.billing.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: data,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.billingDto(updated);
  }

  async getReviews(tenantId: string): Promise<TenantReviewsSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      reviewsAutoRequest: tenant.reviewsAutoRequest,
      reviewRequestDelayDays: tenant.reviewRequestDelayDays,
      googleReviewUrl: tenant.googleReviewUrl,
    };
  }

  async updateReviews(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantReviewsSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantReviewsSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const { input } = args;
    const data: Record<string, string | number | boolean | null> = {};
    if (input.reviewsAutoRequest !== undefined) data.reviewsAutoRequest = input.reviewsAutoRequest;
    if (input.reviewRequestDelayDays !== undefined)
      data.reviewRequestDelayDays = input.reviewRequestDelayDays;
    if (input.googleReviewUrl !== undefined) data.googleReviewUrl = input.googleReviewUrl || null;

    const updated =
      Object.keys(data).length === 0
        ? tenant
        : await this.admin.tenant.update({ where: { id: args.tenantId }, data });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.reviews.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: data,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      reviewsAutoRequest: updated.reviewsAutoRequest,
      reviewRequestDelayDays: updated.reviewRequestDelayDays,
      googleReviewUrl: updated.googleReviewUrl,
    };
  }

  /** White-label del portal del inquilino (color + logo). */
  async getBranding(tenantId: string): Promise<TenantBrandingResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return this.toBrandingResponse(tenant);
  }

  private toBrandingResponse(tenant: {
    portalBrandColor: string | null;
    portalLogoUrl: string | null;
    customDomain: string | null;
    customDomainVerifiedAt: Date | null;
  }): TenantBrandingResponse {
    return {
      portalBrandColor: tenant.portalBrandColor,
      portalLogoUrl: tenant.portalLogoUrl,
      customDomain: tenant.customDomain,
      customDomainVerifiedAt: tenant.customDomainVerifiedAt?.toISOString() ?? null,
    };
  }

  /** ¿El tenant tiene una feature concreta (plan + overrides)? */
  private async hasFeature(tenantId: string, feature: TenantFeature): Promise<boolean> {
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
    return features.includes(feature);
  }

  async updateBranding(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantBrandingInput;
    meta: RequestMeta;
  }): Promise<TenantBrandingResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const { input } = args;
    const data: Prisma.TenantUpdateInput = {};
    if (input.portalBrandColor !== undefined)
      data.portalBrandColor = input.portalBrandColor || null;
    if (input.portalLogoUrl !== undefined) data.portalLogoUrl = input.portalLogoUrl || null;

    if (input.customDomain !== undefined) {
      const domain = input.customDomain.trim().toLowerCase();
      if (domain === '') {
        // Quitar el dominio siempre se permite (p. ej. tras un downgrade).
        data.customDomain = null;
        data.customDomainVerifiedAt = null;
      } else if (domain !== tenant.customDomain) {
        // Setear/cambiar el dominio requiere la feature del plan.
        if (!(await this.hasFeature(args.tenantId, 'custom_domain'))) {
          throw new ForbiddenException({
            code: 'feature_not_in_plan',
            message: 'El dominio propio no está incluido en tu plan',
            details: { requiredFeature: 'custom_domain' },
          });
        }
        const taken = await this.admin.tenant.findFirst({
          where: { customDomain: domain, id: { not: args.tenantId } },
          select: { id: true },
        });
        if (taken) {
          throw new ConflictException({
            code: 'domain_taken',
            message: 'Ese dominio ya está en uso por otra cuenta',
          });
        }
        data.customDomain = domain;
        // Cambiar el dominio invalida la verificación previa (el admin debe
        // reconfigurar el Proxy Host + SSL y reactivarlo).
        data.customDomainVerifiedAt = null;
      }
    }

    const updated =
      Object.keys(data).length === 0
        ? tenant
        : await this.admin.tenant.update({ where: { id: args.tenantId }, data });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.branding.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: data as unknown as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.toBrandingResponse(updated);
  }

  async getContractTemplate(tenantId: string): Promise<ContractTemplateDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { contractClauses: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    return { clauses: tenant.contractClauses };
  }

  async updateContractTemplate(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateContractTemplateInput;
    meta: RequestMeta;
  }): Promise<ContractTemplateDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    // '' o ausente = volver a la plantilla por defecto (null).
    const clauses = args.input.clauses?.trim() ? args.input.clauses : null;
    await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: { contractClauses: clauses },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.contract_template.changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { hasCustomClauses: clauses !== null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return { clauses };
  }

  async getWebSettings(tenantId: string): Promise<WebSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        webTemplate: true,
        webHeadline: true,
        webAbout: true,
        webSections: true,
        deletedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    return {
      template: isWebTemplate(tenant.webTemplate) ? tenant.webTemplate : 'default',
      headline: tenant.webHeadline,
      about: tenant.webAbout,
      sections: parseWebSections(tenant.webSections),
    };
  }

  async updateWebSettings(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateWebSettingsInput;
    meta: RequestMeta;
  }): Promise<WebSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    const { input } = args;
    const data: Prisma.TenantUpdateInput = {};
    if (input.template !== undefined) data.webTemplate = input.template;
    // '' = borrar (null); undefined = no tocar.
    if (input.headline !== undefined) data.webHeadline = input.headline || null;
    if (input.about !== undefined) data.webAbout = input.about || null;
    if (input.sections !== undefined) {
      // Merge parcial sobre las secciones actuales.
      const current = parseWebSections(tenant.webSections);
      data.webSections = { ...current, ...input.sections } as unknown as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length > 0) {
      await this.admin.tenant.update({ where: { id: args.tenantId }, data });
      await this.audit.write({
        tenantId: args.tenantId,
        userId: args.actorUserId,
        action: 'tenant.web_settings.changed',
        entityType: 'Tenant',
        entityId: args.tenantId,
        changes: data as unknown as Prisma.InputJsonValue,
        ipAddress: args.meta.ipAddress ?? null,
        userAgent: args.meta.userAgent ?? null,
      });
    }
    return this.getWebSettings(args.tenantId);
  }

  async getReferrals(tenantId: string): Promise<TenantReferralSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      referralEnabled: tenant.referralEnabled,
      referralRewardType: tenant.referralRewardType,
      referralRewardValue: Number(tenant.referralRewardValue),
    };
  }

  async updateReferrals(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantReferralSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantReferralSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        referralEnabled: args.input.referralEnabled,
        referralRewardType: args.input.referralRewardType,
        referralRewardValue: args.input.referralRewardValue,
      },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.referrals.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: {
        referralEnabled: { from: tenant.referralEnabled, to: updated.referralEnabled },
        referralRewardType: { from: tenant.referralRewardType, to: updated.referralRewardType },
        referralRewardValue: {
          from: Number(tenant.referralRewardValue),
          to: Number(updated.referralRewardValue),
        },
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      referralEnabled: updated.referralEnabled,
      referralRewardType: updated.referralRewardType,
      referralRewardValue: Number(updated.referralRewardValue),
    };
  }

  async getAccess(tenantId: string): Promise<TenantAccessSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      extraAccessLimit: tenant.extraAccessLimit,
      nightPassEnabled: tenant.nightPassEnabled,
      nightPassPrice: Number(tenant.nightPassPrice),
    };
  }

  async updateAccess(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantAccessSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantAccessSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        ...(args.input.extraAccessLimit !== undefined
          ? { extraAccessLimit: args.input.extraAccessLimit }
          : {}),
        ...(args.input.nightPassEnabled !== undefined
          ? { nightPassEnabled: args.input.nightPassEnabled }
          : {}),
        ...(args.input.nightPassPrice !== undefined
          ? { nightPassPrice: args.input.nightPassPrice }
          : {}),
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.access.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { ...args.input },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return {
      extraAccessLimit: updated.extraAccessLimit,
      nightPassEnabled: updated.nightPassEnabled,
      nightPassPrice: Number(updated.nightPassPrice),
    };
  }
}
