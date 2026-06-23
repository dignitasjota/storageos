import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  TenantAccessSettingsResponse,
  TenantBillingSettingsResponse,
  TenantReferralSettingsResponse,
  TenantReviewsSettingsResponse,
  TenantSecuritySettingsResponse,
  UpdateTenantAccessSettingsInput,
  UpdateTenantBillingSettingsInput,
  UpdateTenantReferralSettingsInput,
  UpdateTenantReviewsSettingsInput,
  UpdateTenantSecuritySettingsInput,
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
    lateFeeEnabled: boolean;
    lateFeeType: string;
    lateFeeValue: unknown;
    lateFeeGraceDays: number;
  }): TenantBillingSettingsResponse {
    return {
      autoChargeOnIssue: tenant.autoChargeOnIssue,
      lateFeeEnabled: tenant.lateFeeEnabled,
      lateFeeType: tenant.lateFeeType as 'percentage' | 'fixed',
      lateFeeValue: Number(tenant.lateFeeValue),
      lateFeeGraceDays: tenant.lateFeeGraceDays,
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
    if (input.lateFeeEnabled !== undefined) data.lateFeeEnabled = input.lateFeeEnabled;
    if (input.lateFeeType !== undefined) data.lateFeeType = input.lateFeeType;
    if (input.lateFeeValue !== undefined) data.lateFeeValue = input.lateFeeValue;
    if (input.lateFeeGraceDays !== undefined) data.lateFeeGraceDays = input.lateFeeGraceDays;

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
