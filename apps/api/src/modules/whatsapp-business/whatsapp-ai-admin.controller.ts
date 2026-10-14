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
  type AdminTenantWhatsappAiDto,
  type PlatformWhatsappAiDto,
  UpdateAdminTenantWhatsappAiSchema,
  UpdatePlatformWhatsappAiSchema,
  type WhatsappAiTestResultDto,
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

import { WhatsappAssistantService } from './whatsapp-assistant.service';

import type { Request } from 'express';

class UpdatePlatformWhatsappAiBody extends createZodDto(UpdatePlatformWhatsappAiSchema) {}
class UpdateAdminTenantWhatsappAiBody extends createZodDto(UpdateAdminTenantWhatsappAiSchema) {}

/**
 * IA del asistente de WhatsApp (panel admin): la de la plataforma y el modo de
 * cada tenant. Leer: super admin y soporte; cambiar: rol superadmin.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class WhatsappAiAdminController {
  constructor(
    private readonly assistant: WhatsappAssistantService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  @Get('whatsapp-ai')
  get(): Promise<PlatformWhatsappAiDto> {
    return this.assistant.getPlatform();
  }

  @RequireSuperadmin()
  @Put('whatsapp-ai')
  async update(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: UpdatePlatformWhatsappAiBody,
    @Req() req: Request,
  ): Promise<PlatformWhatsappAiDto> {
    const result = await this.assistant.updatePlatform(body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.whatsapp_ai.updated',
      targetType: 'PlatformWhatsappAiSettings',
      changes: {
        enabled: result.enabled,
        provider: result.provider,
        model: result.model,
        monthlyReplyLimit: result.monthlyReplyLimit,
        keyChanged: body.apiKey !== undefined,
      },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }

  @RequireSuperadmin()
  @Post('whatsapp-ai/test')
  @HttpCode(HttpStatus.OK)
  test(): Promise<WhatsappAiTestResultDto> {
    return this.assistant.testPlatform();
  }

  @Get('tenants/:id/whatsapp-ai')
  getTenant(@Param('id', ParseUUIDPipe) id: string): Promise<AdminTenantWhatsappAiDto> {
    return this.assistant.getForAdmin(id);
  }

  @RequireSuperadmin()
  @Put('tenants/:id/whatsapp-ai')
  async updateTenant(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAdminTenantWhatsappAiBody,
    @Req() req: Request,
  ): Promise<AdminTenantWhatsappAiDto> {
    const result = await this.assistant.updateForAdmin(id, body);
    await this.audit.record({
      superAdminId: admin.sub,
      action: 'admin.tenant.whatsapp_ai_changed',
      targetType: 'Tenant',
      targetId: id,
      targetTenantId: id,
      changes: { ...body },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }
}
