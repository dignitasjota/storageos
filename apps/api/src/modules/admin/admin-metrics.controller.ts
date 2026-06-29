import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminMetricsService } from './admin-metrics.service';
import { AdminGuard } from './admin.guard';
import { MrrSnapshotService } from './mrr-snapshot.service';

import type { AdminMetricsDto, AdminMetricsMrrMovementsDto } from '@storageos/shared';

@Public()
@UseGuards(AdminGuard)
@Controller('admin/metrics')
export class AdminMetricsController {
  constructor(
    private readonly metrics: AdminMetricsService,
    private readonly mrr: MrrSnapshotService,
  ) {}

  @Get()
  async overview(): Promise<AdminMetricsDto> {
    return this.metrics.getOverview();
  }

  /** Desglose mensual del cambio de MRR (new/expansion/contraction/churn/...). */
  @Get('mrr-movements')
  async mrrMovements(@Query('months') months?: string): Promise<AdminMetricsMrrMovementsDto> {
    const n = months ? Number(months) : 12;
    return this.mrr.getMovements(Number.isFinite(n) ? n : 12);
  }
}
