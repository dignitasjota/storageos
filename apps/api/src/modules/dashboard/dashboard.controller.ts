import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { TodayService } from './today.service';

import type { TodayDto } from '@storageos/shared';

/** Bandeja operativa del día para el panel del tenant. */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly today: TodayService) {}

  @Get('today')
  async getToday(@CurrentUser() user: AuthenticatedUser): Promise<TodayDto> {
    return this.today.getToday(user.tenantId);
  }
}
