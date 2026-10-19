import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

import { AdminTenantsOverviewService } from './admin-tenants-overview.service';
import { AdminGuard } from './admin.guard';

import type { AdminSearchResultDto, AdminTenantOverviewDto } from '@storageos/shared';

/** Visión general de los tenants y búsqueda global del panel admin. */
@Public()
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminTenantsOverviewController {
  constructor(private readonly service: AdminTenantsOverviewService) {}

  @Get('tenants-overview')
  overview(): Promise<AdminTenantOverviewDto[]> {
    return this.service.overview();
  }

  @Get('search')
  search(@Query('q') q?: string): Promise<AdminSearchResultDto> {
    return this.service.search(q ?? '');
  }
}
