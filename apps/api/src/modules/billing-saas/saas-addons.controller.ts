import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AssignAddonSchema,
  SetAddonBillingModeSchema,
  UpsertSaasAddonSchema,
  type AdminAddonAnalyticsDto,
  type SaasAddonDto,
  type TenantBillingSummaryDto,
  type TenantLimitsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';

import { SaasAddonsService } from './saas-addons.service';

import type { Request } from 'express';

class UpsertSaasAddonDto extends createZodDto(UpsertSaasAddonSchema) {}
class AssignAddonDto extends createZodDto(AssignAddonSchema) {}
class SetAddonBillingModeDto extends createZodDto(SetAddonBillingModeSchema) {}

/** Extrae IP + user-agent del request para dejar rastro en la auditoría. */
function extractMeta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

/**
 * Gestión del catálogo de add-ons facturables del SaaS y su asignación por
 * tenant. Solo super admin (`AdminGuard`). `@Public()` salta el JwtAuthGuard de
 * tenant (el caller es un super admin con su propio token).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class SaasAddonsController {
  constructor(
    private readonly service: SaasAddonsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Get('addons/analytics')
  analytics(): Promise<AdminAddonAnalyticsDto[]> {
    return this.service.catalogAnalytics();
  }

  @Get('addons')
  listCatalog(): Promise<SaasAddonDto[]> {
    return this.service.listCatalog();
  }

  @RequireSuperadmin()
  @Post('addons')
  async createAddon(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: UpsertSaasAddonDto,
    @Req() req: Request,
  ): Promise<SaasAddonDto> {
    const created = await this.service.createAddon(body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.saas_addon.created',
      targetType: 'saas_addon',
      targetId: created.id,
      changes: { slug: created.slug, name: created.name, priceMonthly: created.priceMonthly },
      ...extractMeta(req),
    });
    return created;
  }

  @RequireSuperadmin()
  @Patch('addons/:id')
  async updateAddon(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpsertSaasAddonDto,
    @Req() req: Request,
  ): Promise<SaasAddonDto> {
    const updated = await this.service.updateAddon(id, body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.saas_addon.updated',
      targetType: 'saas_addon',
      targetId: id,
      changes: { slug: updated.slug, name: updated.name, priceMonthly: updated.priceMonthly },
      ...extractMeta(req),
    });
    return updated;
  }

  @Get('tenants/:id/limits')
  tenantLimits(@Param('id', new ParseUUIDPipe()) id: string): Promise<TenantLimitsDto> {
    return this.service.tenantLimits(id);
  }

  @Get('tenants/:id/billing-summary')
  billingSummary(@Param('id', new ParseUUIDPipe()) id: string): Promise<TenantBillingSummaryDto> {
    return this.service.billingSummary(id);
  }

  @RequireSuperadmin()
  @Post('tenants/:id/addons')
  async assign(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AssignAddonDto,
    @Req() req: Request,
  ): Promise<TenantBillingSummaryDto> {
    const summary = await this.service.assign(id, body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.saas_addon.assigned',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { addonId: body.addonId, quantity: body.quantity ?? null },
      ...extractMeta(req),
    });
    return summary;
  }

  @RequireSuperadmin()
  @Delete('tenants/:id/addons/:assignmentId')
  async remove(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Req() req: Request,
  ): Promise<TenantBillingSummaryDto> {
    const summary = await this.service.remove(id, assignmentId);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.saas_addon.removed',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { assignmentId },
      ...extractMeta(req),
    });
    return summary;
  }

  @RequireSuperadmin()
  @Post('tenants/:id/addons/:assignmentId/suspend')
  async suspend(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Req() req: Request,
  ): Promise<TenantBillingSummaryDto> {
    const summary = await this.service.suspend(id, assignmentId);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.saas_addon.suspended',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { assignmentId },
      ...extractMeta(req),
    });
    return summary;
  }

  @RequireSuperadmin()
  @Post('tenants/:id/addons/:assignmentId/billing-mode')
  async setBillingMode(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() body: SetAddonBillingModeDto,
    @Req() req: Request,
  ): Promise<TenantBillingSummaryDto> {
    const summary = await this.service.setBillingMode(id, assignmentId, body.mode);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.saas_addon.billing_mode_changed',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { assignmentId, mode: body.mode },
      ...extractMeta(req),
    });
    return summary;
  }

  @RequireSuperadmin()
  @Post('tenants/:id/addons/:assignmentId/reactivate')
  async reactivate(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Req() req: Request,
  ): Promise<TenantBillingSummaryDto> {
    const summary = await this.service.reactivate(id, assignmentId);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.saas_addon.reactivated',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
      changes: { assignmentId },
      ...extractMeta(req),
    });
    return summary;
  }
}
