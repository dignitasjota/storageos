import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import { ConnectGa4Schema, type Ga4ReportDto, type Ga4SettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { Ga4Service } from './ga4.service';

class ConnectGa4Dto extends createZodDto(ConnectGa4Schema) {}

/** Google Analytics 4 de la web del tenant. Dentro de Web Premium. */
@RequireFeature('web_premium')
@Controller('marketing/ga4')
export class Ga4Controller {
  constructor(private readonly ga4: Ga4Service) {}

  @RequirePermission('marketing:read')
  @Get()
  settings(@CurrentUser() user: AuthenticatedUser): Promise<Ga4SettingsDto> {
    return this.ga4.settings(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @Put()
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectGa4Dto,
  ): Promise<Ga4SettingsDto> {
    return this.ga4.connect(user.tenantId, body.propertyId);
  }

  @RequirePermission('marketing:manage')
  @Delete()
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<Ga4SettingsDto> {
    return this.ga4.disconnect(user.tenantId);
  }

  /** Descarga ya los últimos días (sin esperar al cron). */
  @RequirePermission('marketing:manage')
  @Post('sync')
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<Ga4SettingsDto> {
    await this.ga4.sync(user.tenantId);
    return this.ga4.settings(user.tenantId);
  }

  @RequirePermission('marketing:read')
  @Get('report')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<Ga4ReportDto> {
    return this.ga4.report(user.tenantId, Number(days) || 30);
  }
}
