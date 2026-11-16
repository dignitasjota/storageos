import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import {
  ConnectSocialSchema,
  type SocialReportDto,
  type SocialSettingsDto,
} from '@storageos/shared';
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
// Ver la conexión y desconectar no piden Web Premium: sin el extra se puede
// borrar lo guardado (el token de Meta, por ejemplo).
@Controller('marketing/social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @RequirePermission('marketing:read')
  @Get()
  settings(@CurrentUser() user: AuthenticatedUser): Promise<SocialSettingsDto> {
    return this.social.settings(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @RequireFeature('web_premium')
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
  @RequireFeature('web_premium')
  @Post('sync')
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<SocialSettingsDto> {
    await this.social.sync(user.tenantId);
    return this.social.settings(user.tenantId);
  }

  @RequirePermission('marketing:read')
  @RequireFeature('web_premium')
  @Get('report')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<SocialReportDto> {
    return this.social.report(user.tenantId, Number(days) || 30);
  }
}
