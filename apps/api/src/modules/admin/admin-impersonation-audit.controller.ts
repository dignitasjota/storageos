import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminImpersonationAuditService } from './admin-impersonation-audit.service';
import { AdminGuard } from './admin.guard';

import type {
  AdminImpersonationActivityDto,
  AdminImpersonationSessionDto,
} from '@storageos/shared';

/** Auditoría de las sesiones de impersonación + su actividad. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/impersonation-logs')
export class AdminImpersonationAuditController {
  constructor(private readonly audit: AdminImpersonationAuditService) {}

  @Get()
  async list(@Query('tenantId') tenantId?: string): Promise<AdminImpersonationSessionDto[]> {
    return this.audit.listSessions(tenantId?.trim() || undefined);
  }

  @Get(':id/activity')
  async activity(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AdminImpersonationActivityDto[]> {
    return this.audit.getActivity(id);
  }
}
