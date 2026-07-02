import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { TodayService } from './today.service';

import type { TodayDto } from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bandeja operativa del día para el panel del tenant. */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly today: TodayService) {}

  @Get('today')
  async getToday(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<TodayDto> {
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.today.getToday(user.tenantId, facilityId || undefined);
  }
}
