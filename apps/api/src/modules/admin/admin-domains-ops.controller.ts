import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminDomainsOpsService } from './admin-domains-ops.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type {
  DomainCleanupDto,
  DomainFullCheckDto,
  DomainGuideDto,
  DomainHistoryItemDto,
  DomainOpsOverviewDto,
} from '@storageos/shared';
import type { Request } from 'express';

class ChecklistDto extends createZodDto(z.object({ steps: z.record(z.string(), z.boolean()) })) {}
class SettingsDto extends createZodDto(z.object({ notifyTenantEnabled: z.boolean() })) {}

const meta = (admin: AuthenticatedSuperAdmin, req: Request) => ({
  superAdminId: admin.sub,
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

/** Dominios propios: comprobación completa, guía, limpieza, historial y ajustes. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/domains')
export class AdminDomainsOpsController {
  constructor(private readonly ops: AdminDomainsOpsService) {}

  @Get('overview')
  overview(): Promise<DomainOpsOverviewDto> {
    return this.ops.overview();
  }

  @Post('check-all')
  @HttpCode(HttpStatus.OK)
  checkAll(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<{ checked: number; failing: number }> {
    return this.ops.checkAll({ byId: admin.sub });
  }

  @Get('cleanups')
  cleanups(@Query('all') all?: string): Promise<DomainCleanupDto[]> {
    return this.ops.cleanups(all === '1');
  }

  @RequireSuperadmin()
  @Post('cleanups/:id/done')
  @HttpCode(HttpStatus.OK)
  cleanupDone(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<DomainCleanupDto> {
    return this.ops.markCleanupDone(id, meta(admin, req));
  }

  @RequireSuperadmin()
  @Put('settings')
  settings(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: SettingsDto,
    @Req() req: Request,
  ): Promise<{ notifyTenantEnabled: boolean }> {
    return this.ops.setNotifyTenant(body.notifyTenantEnabled, meta(admin, req));
  }

  @Post(':tenantId/check')
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<DomainFullCheckDto> {
    return this.ops.fullCheck(tenantId, 'manual', admin.sub);
  }

  @Get(':tenantId/guide')
  guide(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<DomainGuideDto> {
    return this.ops.guide(tenantId);
  }

  @RequireSuperadmin()
  @Put(':tenantId/checklist')
  checklist(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: ChecklistDto,
    @Req() req: Request,
  ): Promise<DomainGuideDto> {
    return this.ops.setChecklist(tenantId, body.steps, meta(admin, req));
  }

  @Get(':tenantId/history')
  history(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<DomainHistoryItemDto[]> {
    return this.ops.history(tenantId);
  }
}
