import { Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AuditLogService } from './audit-log.service';

import type { AuditLogListDto } from '@storageos/shared';

/** Registro de actividad del tenant (solo el owner/gestión lo consulta). */
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly audit: AuditLogService) {}

  @RequirePermission('settings:manage')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
  ): Promise<AuditLogListDto> {
    return this.audit.list(user.tenantId, cursor);
  }
}
