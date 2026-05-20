import { Controller, Get, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminMetricsService } from './admin-metrics.service';
import { AdminGuard } from './admin.guard';

import type { AdminMetricsDto } from '@storageos/shared';

@Public()
@UseGuards(AdminGuard)
@Controller('admin/metrics')
export class AdminMetricsController {
  constructor(private readonly metrics: AdminMetricsService) {}

  @Get()
  async overview(): Promise<AdminMetricsDto> {
    return this.metrics.getOverview();
  }
}
