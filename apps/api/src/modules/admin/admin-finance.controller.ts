import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminBillingOpsService } from './admin-billing-ops.service';
import { AdminFinanceService } from './admin-finance.service';
import { AdminGuard } from './admin.guard';

import type { AdminCollectionsForecastDto, AdminFinanceOverviewDto } from '@storageos/shared';

/** Dashboard financiero del SaaS (super admin). */
@Public()
@Controller('admin/finance')
@UseGuards(AdminGuard)
export class AdminFinanceController {
  constructor(
    private readonly service: AdminFinanceService,
    private readonly billingOps: AdminBillingOpsService,
  ) {}

  @Get()
  overview(@Query('months') months?: string): Promise<AdminFinanceOverviewDto> {
    return this.service.getOverview(months ? Number(months) : 12);
  }

  /** Lo que se espera cobrar en los próximos 30/60/90 días por forma de cobro. */
  @Get('forecast')
  forecast(): Promise<AdminCollectionsForecastDto> {
    return this.billingOps.collectionsForecast();
  }
}
