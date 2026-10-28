import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

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
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogListDto> {
    const uuid = /^[0-9a-f-]{36}$/i;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if ((userId && !uuid.test(userId)) || (cursor && !uuid.test(cursor))) {
      throw new BadRequestException({ code: 'invalid_id', message: 'Identificador no válido' });
    }
    if ((from && !day.test(from)) || (to && !day.test(to))) {
      throw new BadRequestException({ code: 'invalid_date', message: 'Fecha no válida' });
    }
    const size = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return this.audit.list(
      user.tenantId,
      cursor,
      {
        ...(userId ? { userId } : {}),
        ...(action ? { action: action.slice(0, 80) } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
      size,
    );
  }
}
