import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminBillingOpsService } from './admin-billing-ops.service';
import { AdminGuard } from './admin.guard';

import type {
  AdminBillingCalendarDto,
  AdminReceivablesDto,
  AdminTenantAccountDto,
} from '@storageos/shared';

const clamp = (v: string | undefined, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : def;
};

/** Pagos de los tenants a TrasterOS: cuenta, cobros pendientes y calendario. */
@Public()
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminBillingOpsController {
  constructor(private readonly service: AdminBillingOpsService) {}

  @Get('tenants/:id/account')
  account(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantAccountDto> {
    return this.service.account(id);
  }

  @Get('billing/receivables')
  receivables(): Promise<AdminReceivablesDto> {
    return this.service.receivables();
  }

  @Get('billing/calendar')
  calendar(
    @Query('days') days?: string,
    @Query('pastDays') pastDays?: string,
  ): Promise<AdminBillingCalendarDto> {
    return this.service.calendar(clamp(days, 60, 366), clamp(pastDays, 14, 90));
  }
}
