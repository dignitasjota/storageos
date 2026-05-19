import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { DashboardService } from './dashboard.service';

import type { OccupancyDashboardDto } from '@storageos/shared';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('occupancy')
  async occupancy(@CurrentUser() user: AuthenticatedUser): Promise<OccupancyDashboardDto> {
    return this.dashboard.occupancy(user.tenantId);
  }
}
