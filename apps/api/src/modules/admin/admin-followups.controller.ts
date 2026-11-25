import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { type TenantFollowupDto, UpdateTenantFollowupSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Request } from 'express';

class UpdateTenantFollowupDto extends createZodDto(UpdateTenantFollowupSchema) {}

/**
 * Bandeja global de seguimientos pendientes + acciones por seguimiento. Los
 * de un tenant concreto se crean/listan desde `AdminTenantsController`
 * (`/admin/tenants/:id/followups`).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/followups')
export class AdminFollowupsController {
  constructor(
    private readonly followups: AdminTenantFollowupsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  /** Pendientes de todos los tenants, por fecha de recordatorio (`?mine=1`: los míos). */
  @Get()
  async pending(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query('mine') mine?: string,
  ): Promise<TenantFollowupDto[]> {
    return this.followups.listPending(mine === '1' ? admin.sub : null);
  }

  /** Marca como hecho o reabre, pospone o cambia quién se encarga. */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTenantFollowupDto,
    @Req() req: Request,
  ): Promise<TenantFollowupDto> {
    const dto = await this.followups.update(id, body, admin.sub);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.followup_updated',
      targetType: 'tenant',
      targetId: dto.tenantId,
      targetTenantId: dto.tenantId,
      changes: { followupId: id, fields: Object.keys(body) },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return dto;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const tenantId = await this.followups.remove(id);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.followup_deleted',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: { followupId: id },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
