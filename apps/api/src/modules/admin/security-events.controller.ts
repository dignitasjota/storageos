import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ListSecurityEventsSchema,
  type SecurityEventDto,
  type SecurityEventsListResponseDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { SecurityEventsService } from '../security-events/security-events.service';

import { AdminGuard } from './admin.guard';

import type { SecurityEvent } from '@storageos/database';

class ListSecurityEventsDto extends createZodDto(ListSecurityEventsSchema) {}

/**
 * Endpoints `/admin/security-events` — solo visibles para super admin.
 *
 * `@Public()` salta el `JwtAuthGuard` global (que espera tokens de tenant);
 * la autorizacion la hace `AdminGuard` con `SUPER_ADMIN_JWT_SECRET`.
 */
@ApiTags('Admin')
@ApiBearerAuth('jwt')
@Public()
@UseGuards(AdminGuard)
@Controller('admin/security-events')
export class SecurityEventsController {
  constructor(private readonly service: SecurityEventsService) {}

  @Get()
  async list(@Query() query: ListSecurityEventsDto): Promise<SecurityEventsListResponseDto> {
    const result = await this.service.list({
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.emailAttempted ? { emailAttempted: query.emailAttempted } : {}),
      ...(query.fromDate ? { fromDate: query.fromDate } : {}),
      ...(query.toDate ? { toDate: query.toDate } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    return {
      items: result.items.map(toSecurityEventDto),
      nextCursor: result.nextCursor,
    };
  }
}

function toSecurityEventDto(row: SecurityEvent): SecurityEventDto {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    eventType: row.eventType,
    emailAttempted: row.emailAttempted,
    tenantSlugAttempted: row.tenantSlugAttempted,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    reason: row.reason,
    rawMetadata:
      row.rawMetadata !== null &&
      typeof row.rawMetadata === 'object' &&
      !Array.isArray(row.rawMetadata)
        ? (row.rawMetadata as Record<string, unknown>)
        : null,
  };
}
