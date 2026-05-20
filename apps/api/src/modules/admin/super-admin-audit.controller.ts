import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ListSuperAdminAuditLogsSchema,
  type SuperAdminAuditLogDto,
  type SuperAdminAuditLogsListResponseDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import {
  SuperAdminAuditService,
  type SuperAdminAuditLogWithActor,
} from './super-admin-audit.service';

class ListSuperAdminAuditLogsDto extends createZodDto(ListSuperAdminAuditLogsSchema) {}

/**
 * Endpoints `/admin/audit-logs` — solo visibles para super admin.
 *
 * `@Public()` salta el `JwtAuthGuard` global (que espera tokens de tenant);
 * la autorizacion la hace `AdminGuard` con `SUPER_ADMIN_JWT_SECRET`.
 */
@ApiTags('Admin')
@ApiBearerAuth('jwt')
@Public()
@UseGuards(AdminGuard)
@Controller('admin/audit-logs')
export class SuperAdminAuditController {
  constructor(private readonly service: SuperAdminAuditService) {}

  @Get()
  async list(
    @Query() query: ListSuperAdminAuditLogsDto,
  ): Promise<SuperAdminAuditLogsListResponseDto> {
    const result = await this.service.list({
      ...(query.superAdminId ? { superAdminId: query.superAdminId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetTenantId ? { targetTenantId: query.targetTenantId } : {}),
      ...(query.fromDate ? { fromDate: query.fromDate } : {}),
      ...(query.toDate ? { toDate: query.toDate } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return {
      items: result.items.map(toSuperAdminAuditLogDto),
      nextCursor: result.nextCursor,
    };
  }
}

function toSuperAdminAuditLogDto(row: SuperAdminAuditLogWithActor): SuperAdminAuditLogDto {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    superAdminId: row.superAdminId,
    superAdminEmail: row.superAdmin?.email ?? null,
    superAdminFullName: row.superAdmin?.fullName ?? null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetTenantId: row.targetTenantId,
    changes:
      row.changes !== null && typeof row.changes === 'object' && !Array.isArray(row.changes)
        ? (row.changes as Record<string, unknown>)
        : null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  };
}
