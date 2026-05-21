import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ListSecurityEventsSchema,
  type SecurityEventDto,
  type SecurityEventsListResponseDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator';
import {
  SecurityEventsService,
  type SecurityEventStatsResult,
} from '../security-events/security-events.service';

import { AdminGuard } from './admin.guard';

import type { Env } from '../../config/env.schema';
import type { SecurityEvent } from '@storageos/database';

class ListSecurityEventsDto extends createZodDto(ListSecurityEventsSchema) {}

const StatsQuerySchema = z.object({
  window: z.enum(['24h', '7d', '30d']).default('24h'),
});
class StatsQueryDto extends createZodDto(StatsQuerySchema) {}

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
  constructor(
    private readonly service: SecurityEventsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('stats')
  async stats(@Query() query: StatsQueryDto): Promise<SecurityEventStatsResult> {
    const windowHours = query.window === '24h' ? 24 : query.window === '7d' ? 24 * 7 : 24 * 30;
    const bucket: 'hour' | 'day' = query.window === '24h' ? 'hour' : 'day';
    const bruteForceThreshold = this.config.get('SECURITY_BRUTE_FORCE_THRESHOLD', { infer: true });
    return this.service.stats({ windowHours, bucket, bruteForceThreshold });
  }

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
