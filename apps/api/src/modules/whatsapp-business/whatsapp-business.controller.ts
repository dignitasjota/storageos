import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  SendWhatsappMessageSchema,
  SendWhatsappTemplateSchema,
  RequestWhatsappMediaUploadSchema,
  SendWhatsappMediaSchema,
  type WhatsappMediaUploadDto,
  type WhatsappTemplatesDto,
  UpdateWhatsappAssistantSchema,
  UpdateWhatsappConversationSchema,
  UpdateWhatsappSettingsSchema,
  type WhatsappAiTestResultDto,
  type WhatsappAssistantDto,
  type WhatsappConversationDetailDto,
  type WhatsappConversationDto,
  type WhatsappMessageDto,
  type WhatsappSettingsDto,
  type WhatsappTestResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { WhatsappAssistantService } from './whatsapp-assistant.service';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappSettingsService } from './whatsapp-settings.service';

import type { Request } from 'express';

class UpdateWhatsappSettingsBody extends createZodDto(UpdateWhatsappSettingsSchema) {}
class SendWhatsappMessageBody extends createZodDto(SendWhatsappMessageSchema) {}
class SendWhatsappTemplateBody extends createZodDto(SendWhatsappTemplateSchema) {}
class RequestWhatsappMediaUploadBody extends createZodDto(RequestWhatsappMediaUploadSchema) {}
class SendWhatsappMediaBody extends createZodDto(SendWhatsappMediaSchema) {}
class UpdateWhatsappAssistantBody extends createZodDto(UpdateWhatsappAssistantSchema) {}
class UpdateWhatsappConversationBody extends createZodDto(UpdateWhatsappConversationSchema) {}

function meta(req: Request): { ipAddress?: string; userAgent?: string } {
  const ua = req.header('user-agent');
  return { ...(req.ip ? { ipAddress: req.ip } : {}), ...(ua ? { userAgent: ua } : {}) };
}

@RequireFeature('whatsapp_business')
@Controller('settings/whatsapp')
export class WhatsappSettingsController {
  constructor(
    private readonly settings: WhatsappSettingsService,
    private readonly assistant: WhatsappAssistantService,
  ) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateWhatsappSettingsBody,
    @Req() req: Request,
  ): Promise<WhatsappSettingsDto> {
    const ua = req.header('user-agent');
    return this.settings.update({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: { ...(req.ip ? { ipAddress: req.ip } : {}), ...(ua ? { userAgent: ua } : {}) },
    });
  }

  @RequirePermission('settings:manage')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappTestResultDto> {
    return this.settings.test(user.tenantId);
  }

  @RequirePermission('settings:read')
  @Get('assistant')
  getAssistant(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappAssistantDto> {
    return this.assistant.getForTenant(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put('assistant')
  updateAssistant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateWhatsappAssistantBody,
    @Req() req: Request,
  ): Promise<WhatsappAssistantDto> {
    return this.assistant.updateForTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: meta(req),
    });
  }

  /** Prueba la clave de IA propia del tenant. */
  @RequirePermission('settings:manage')
  @Post('assistant/test')
  @HttpCode(HttpStatus.OK)
  testAssistant(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappAiTestResultDto> {
    return this.assistant.testOwn(user.tenantId);
  }
}

@RequireFeature('whatsapp_business')
@Controller('whatsapp/conversations')
export class WhatsappConversationsController {
  constructor(private readonly inbox: WhatsappInboxService) {}

  @RequirePermission('communications:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappConversationDto[]> {
    return this.inbox.list(user.tenantId);
  }

  @RequirePermission('communications:read')
  /** Plantillas aprobadas en Meta (para enviarlas pasadas 24 h). */
  @RequirePermission('communications:send')
  @Get('templates')
  templates(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappTemplatesDto> {
    return this.inbox.listTemplates(user.tenantId);
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return { count: await this.inbox.unreadCount(user.tenantId) };
  }

  @RequirePermission('communications:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WhatsappConversationDetailDto> {
    return this.inbox.detail(user.tenantId, id);
  }

  /** Activa o pausa el asistente en esta conversación. */
  @RequirePermission('communications:send')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWhatsappConversationBody,
  ): Promise<WhatsappConversationDto> {
    return this.inbox.setAssistant(user.tenantId, id, body.assistantEnabled);
  }

  @RequirePermission('communications:send')
  @Post(':id/messages')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendWhatsappMessageBody,
  ): Promise<WhatsappMessageDto> {
    return this.inbox.send({
      tenantId: user.tenantId,
      userId: user.sub,
      conversationId: id,
      body: body.body,
    });
  }

  /** Mensaje con plantilla aprobada (pasadas 24 h desde el último mensaje del contacto). */
  @RequirePermission('communications:send')
  @Post(':id/template')
  sendTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendWhatsappTemplateBody,
  ): Promise<WhatsappMessageDto> {
    return this.inbox.sendTemplate({
      tenantId: user.tenantId,
      userId: user.sub,
      conversationId: id,
      input: body,
    });
  }

  /** URL para subir un archivo (foto o PDF) que se enviará en la conversación. */
  @RequirePermission('communications:send')
  @Post(':id/media/upload-url')
  mediaUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RequestWhatsappMediaUploadBody,
  ): Promise<WhatsappMediaUploadDto> {
    return this.inbox.requestMediaUpload({
      tenantId: user.tenantId,
      conversationId: id,
      input: body,
    });
  }

  /** Envía el archivo ya subido (dentro de las 24 h). */
  @RequirePermission('communications:send')
  @Post(':id/media')
  sendMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendWhatsappMediaBody,
  ): Promise<WhatsappMessageDto> {
    return this.inbox.sendMedia({
      tenantId: user.tenantId,
      userId: user.sub,
      conversationId: id,
      input: body,
    });
  }
}
