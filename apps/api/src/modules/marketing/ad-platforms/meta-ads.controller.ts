import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { UpdateMetaAdsSettingsSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { AuditService } from '../../auth/audit.service';

import { MetaAdsSettingsService } from './meta-ads-settings.service';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { AdPlatformTestResultDto, MetaAdsSettingsDto } from '@storageos/shared';
import type { Request } from 'express';

class UpdateMetaAdsSettingsBody extends createZodDto(UpdateMetaAdsSettingsSchema) {}

@Controller('settings/marketing/meta-ads')
export class MetaAdsController {
  constructor(
    private readonly settings: MetaAdsSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Constancia de cada cambio de las credenciales (sin ellas: solo qué se tocó). */
  private async trace(
    user: AuthenticatedUser,
    req: Request,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action,
      entityType: 'Tenant',
      entityId: user.tenantId,
      changes: changes as never,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @RequirePermission('marketing:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<MetaAdsSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @Put()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Body() body: UpdateMetaAdsSettingsBody,
  ): Promise<MetaAdsSettingsDto> {
    const result = await this.settings.update(user.tenantId, body);
    await this.trace(user, req, 'marketing.meta_ads_settings_changed', {
      enabled: body.enabled,
      // Solo los nombres de lo que se cambió, nunca su valor.
      fields: Object.keys(body).filter((k) => k !== 'enabled'),
    });
    return result;
  }

  @RequirePermission('marketing:manage')
  @Delete()
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<MetaAdsSettingsDto> {
    const result = await this.settings.remove(user.tenantId);
    await this.trace(user, req, 'marketing.meta_ads_settings_deleted', {});
    return result;
  }

  @RequirePermission('marketing:manage')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentUser() user: AuthenticatedUser): Promise<AdPlatformTestResultDto> {
    return this.settings.test(user.tenantId);
  }
}
