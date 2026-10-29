import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AiConnectionTestDto,
  type AiUsageDto,
  type PlatformAiSettingsDto,
  UpdatePlatformAiSettingsSchema,
  UpdateTenantAiLimitSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';

import { AiQuotaService } from './ai-quota.service';
import { PlatformAiSettingsService } from './platform-ai-settings.service';

import type { Request } from 'express';

class UpdatePlatformAiSettingsBody extends createZodDto(UpdatePlatformAiSettingsSchema) {}
class UpdateTenantAiLimitBody extends createZodDto(UpdateTenantAiLimitSchema) {}

/**
 * Asistente IA del panel (panel admin): clave, modelo y límites de la
 * plataforma, y el consumo y límite de cada tenant. Leer: super admin y
 * soporte; cambiar: rol superadmin.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AiAdminController {
  constructor(
    private readonly settings: PlatformAiSettingsService,
    private readonly quota: AiQuotaService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Get('ai-settings')
  async get(): Promise<PlatformAiSettingsDto> {
    await this.settings.refresh();
    return this.settings.get();
  }

  @RequireSuperadmin()
  @Put('ai-settings')
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: UpdatePlatformAiSettingsBody,
    @Req() req: Request,
  ): Promise<PlatformAiSettingsDto> {
    const result = await this.settings.update(body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.ai_settings.updated',
      targetType: 'PlatformAiSettings',
      changes: {
        keyChanged: body.apiKey !== undefined,
        keyRemoved: body.apiKey === '',
        model: body.model,
        monthlyQueryLimit: body.monthlyQueryLimit,
        dailyUserLimit: body.dailyUserLimit,
      },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }

  @RequireSuperadmin()
  @Post('ai-settings/test')
  @HttpCode(HttpStatus.OK)
  test(): Promise<AiConnectionTestDto> {
    return this.settings.test();
  }

  @Get('tenants/:id/ai-usage')
  usage(@Param('id', ParseUUIDPipe) id: string): Promise<AiUsageDto> {
    return this.quota.usage(id);
  }

  @RequireSuperadmin()
  @Put('tenants/:id/ai-usage')
  async setLimit(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTenantAiLimitBody,
    @Req() req: Request,
  ): Promise<AiUsageDto> {
    const result = await this.quota.setTenantLimit(id, body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.ai_limit_changed',
      targetType: 'Tenant',
      targetId: id,
      targetTenantId: id,
      changes: { monthlyLimit: body.monthlyLimit, mode: body.mode },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }
}
