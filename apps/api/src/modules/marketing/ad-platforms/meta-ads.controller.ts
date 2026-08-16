import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { UpdateMetaAdsSettingsSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { MetaAdsSettingsService } from './meta-ads-settings.service';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { AdPlatformTestResultDto, MetaAdsSettingsDto } from '@storageos/shared';

class UpdateMetaAdsSettingsBody extends createZodDto(UpdateMetaAdsSettingsSchema) {}

@Controller('settings/marketing/meta-ads')
export class MetaAdsController {
  constructor(private readonly settings: MetaAdsSettingsService) {}

  @RequirePermission('marketing:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<MetaAdsSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateMetaAdsSettingsBody,
  ): Promise<MetaAdsSettingsDto> {
    return this.settings.update(user.tenantId, body);
  }

  @RequirePermission('marketing:manage')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentUser() user: AuthenticatedUser): Promise<AdPlatformTestResultDto> {
    return this.settings.test(user.tenantId);
  }
}
