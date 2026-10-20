import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import {
  ConnectSearchConsoleSchema,
  type SearchConsoleSettingsDto,
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

class ConnectSearchConsoleDto extends createZodDto(ConnectSearchConsoleSchema) {}

/** Posiciones en Google con Search Console. Extra «SEO local». */
@RequireFeature('local_seo')
@Controller('seo')
export class SearchConsoleController {
  constructor(private readonly gsc: SearchConsoleService) {}

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
}
