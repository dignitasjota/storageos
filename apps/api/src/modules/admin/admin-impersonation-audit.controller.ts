import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminImpersonationAuditService } from './admin-impersonation-audit.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type {
  AdminImpersonationActivityDto,
  AdminImpersonationSessionDto,
} from '@storageos/shared';
import type { Request } from 'express';

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

  /**
   * Kill switch: corta una sesión de impersonación en curso (el JWT ya
   * emitido deja de ser válido en la siguiente request, ver `JwtStrategy`).
   * Solo `superadmin` (no `support`) — acción de seguridad, no de lectura.
   */
  @RequireSuperadmin()
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AdminImpersonationSessionDto> {
    return this.audit.revoke(id, {
      superAdminId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
