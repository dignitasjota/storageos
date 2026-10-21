import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import {
  ConnectSearchConsoleSchema,
  SeoMonthlyReportToggleSchema,
  type SearchConsoleSettingsDto,
  type SeoMonthlyReportDto,
  type SeoPositionsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { SearchConsoleService } from './search-console.service';
import { SeoReportService } from './seo-report.service';

class ConnectSearchConsoleDto extends createZodDto(ConnectSearchConsoleSchema) {}
class ToggleReportDto extends createZodDto(SeoMonthlyReportToggleSchema) {}

/** Posiciones en Google con Search Console. Extra «SEO local». */
@RequireFeature('local_seo')
@Controller('seo')
export class SearchConsoleController {
  constructor(
    private readonly gsc: SearchConsoleService,
    private readonly report: SeoReportService,
  ) {}

  @RequirePermission('settings:read')
  @Get('search-console')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<SearchConsoleSettingsDto> {
    return this.gsc.settings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put('search-console')
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectSearchConsoleDto,
  ): Promise<SearchConsoleSettingsDto> {
    return this.gsc.connect(user.tenantId, body.siteUrl);
  }

  @RequirePermission('settings:manage')
  @Delete('search-console')
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<SearchConsoleSettingsDto> {
    return this.gsc.disconnect(user.tenantId);
  }

  /** Descarga ya los últimos días (sin esperar al cron). */
  @RequirePermission('settings:manage')
  @Post('search-console/sync')
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<SearchConsoleSettingsDto> {
    await this.gsc.sync(user.tenantId);
    return this.gsc.settings(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get('positions')
  positions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<SeoPositionsDto> {
    return this.gsc.positions(user.tenantId, Number(days) || 28);
  }

  /** Informe de un mes (`?month=AAAA-MM`; por defecto, el mes pasado). */
  @RequirePermission('analytics:read')
  @Get('report')
  monthlyReport(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ): Promise<SeoMonthlyReportDto> {
    return this.report.build(user.tenantId, month || undefined);
  }

  /** Envía ya el informe del mes pasado a los propietarios. */
  @RequirePermission('settings:manage')
  @Post('report/send')
  sendReport(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ recipients: number; month: string }> {
    return this.report.send(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put('search-console/report')
  async toggleReport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ToggleReportDto,
  ): Promise<SearchConsoleSettingsDto> {
    await this.report.setMonthlyReport(user.tenantId, body.enabled);
    return this.gsc.settings(user.tenantId);
  }
}
