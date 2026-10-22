import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { ConnectSocialSchema, type SocialSettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { SocialService } from './social.service';

class ConnectSocialDto extends createZodDto(ConnectSocialSchema) {}

/** Instagram y Facebook orgánico del tenant. Dentro de Web Premium. */
@RequireFeature('web_premium')
@Controller('marketing/social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @RequirePermission('marketing:read')
  @Get()
  settings(@CurrentUser() user: AuthenticatedUser): Promise<SocialSettingsDto> {
    return this.social.settings(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @Put()
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectSocialDto,
  ): Promise<SocialSettingsDto> {
    return this.social.connect(user.tenantId, body);
  }

  @RequirePermission('marketing:manage')
  @Delete()
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<SocialSettingsDto> {
    return this.social.disconnect(user.tenantId);
  }

  /** Descarga ya los últimos días (sin esperar al cron). */
  @RequirePermission('marketing:manage')
  @Post('sync')
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<SocialSettingsDto> {
    await this.social.sync(user.tenantId);
    return this.social.settings(user.tenantId);
  }
}
