import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';
import { PlatformEmailLogService } from '../email/platform-email-log.service';

import { AdminGuard } from './admin.guard';

import type { PlatformEmailLogPageDto } from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Historial de los correos que manda la plataforma (lectura: también soporte). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/email-log')
export class AdminEmailLogController {
  constructor(private readonly log: PlatformEmailLogService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('tenantId') tenantId?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
  ): Promise<PlatformEmailLogPageDto> {
    for (const [key, value] of [
      ['cursor', cursor],
      ['tenantId', tenantId],
    ] as const) {
      if (value && !UUID_RE.test(value)) {
        throw new BadRequestException({ code: 'invalid_id', message: `${key} no es un UUID` });
      }
    }
    return this.log.list({
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number(limit) || 50 } : {}),
      ...(search ? { search } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
    });
  }
}
