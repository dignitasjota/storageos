import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminFinanceService } from './admin-finance.service';
import { AdminGuard } from './admin.guard';

import type { AdminFinanceOverviewDto } from '@storageos/shared';

/** Dashboard financiero del SaaS (super admin). */
@Public()
@Controller('admin/finance')
@UseGuards(AdminGuard)
export class AdminFinanceController {
  constructor(private readonly service: AdminFinanceService) {}

  @Get()
  overview(@Query('months') months?: string): Promise<AdminFinanceOverviewDto> {
    return this.service.getOverview(months ? Number(months) : 12);
  }
}
