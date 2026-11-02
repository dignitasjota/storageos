import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PLATFORM_EMAIL_KINDS } from '@storageos/shared';

import { Public } from '../../common/decorators/public.decorator';
import { PlatformEmailLogService } from '../email/platform-email-log.service';

import { AdminGuard } from './admin.guard';

import type { PlatformEmailLogPageDto } from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['sent', 'delivered', 'bounced', 'failed', 'suppressed'];

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
    if (status && !STATUSES.includes(status)) {
      throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
    }
    if (kind && !(PLATFORM_EMAIL_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({ code: 'invalid_kind', message: 'Tipo de correo no válido' });
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
