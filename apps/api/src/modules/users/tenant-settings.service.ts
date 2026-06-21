import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  TenantBillingSettingsResponse,
  TenantReviewsSettingsResponse,
  TenantSecuritySettingsResponse,
  UpdateTenantBillingSettingsInput,
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

  async getBilling(tenantId: string): Promise<TenantBillingSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return { autoChargeOnIssue: tenant.autoChargeOnIssue };
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
    const prev = tenant.autoChargeOnIssue;
    const next = args.input.autoChargeOnIssue;

    if (prev === next) {
      return { autoChargeOnIssue: next };
    }

    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: { autoChargeOnIssue: next },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.billing.auto_charge_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { from: prev, to: next },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return { autoChargeOnIssue: updated.autoChargeOnIssue };
  }

  async getReviews(tenantId: string): Promise<TenantReviewsSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      reviewsAutoRequest: tenant.reviewsAutoRequest,
      reviewRequestDelayDays: tenant.reviewRequestDelayDays,
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
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        reviewsAutoRequest: args.input.reviewsAutoRequest,
        reviewRequestDelayDays: args.input.reviewRequestDelayDays,
      },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.reviews.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: {
        reviewsAutoRequest: { from: tenant.reviewsAutoRequest, to: updated.reviewsAutoRequest },
        reviewRequestDelayDays: {
          from: tenant.reviewRequestDelayDays,
          to: updated.reviewRequestDelayDays,
        },
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      reviewsAutoRequest: updated.reviewsAutoRequest,
      reviewRequestDelayDays: updated.reviewRequestDelayDays,
    };
  }
}
