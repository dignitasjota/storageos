import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { UpdateGoogleAdsSettingsSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { GoogleAdsSettingsService } from './google-ads-settings.service';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { AdPlatformTestResultDto, GoogleAdsSettingsDto } from '@storageos/shared';

class UpdateGoogleAdsSettingsBody extends createZodDto(UpdateGoogleAdsSettingsSchema) {}

@Controller('settings/marketing/google-ads')
export class GoogleAdsController {
  constructor(private readonly settings: GoogleAdsSettingsService) {}

  @RequirePermission('marketing:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<GoogleAdsSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateGoogleAdsSettingsBody,
  ): Promise<GoogleAdsSettingsDto> {
    return this.settings.update(user.tenantId, body);
  }

  @RequirePermission('marketing:manage')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentUser() user: AuthenticatedUser): Promise<AdPlatformTestResultDto> {
    return this.settings.test(user.tenantId);
  }
}
