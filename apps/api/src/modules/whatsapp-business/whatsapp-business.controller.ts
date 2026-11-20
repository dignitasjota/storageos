import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  SendWhatsappMessageSchema,
  SendWhatsappTemplateSchema,
  RequestWhatsappMediaUploadSchema,
  SendWhatsappMediaSchema,
  TestWhatsappOwnAiSchema,
  TestWhatsappSettingsSchema,
  type WhatsappMediaUploadDto,
  type WhatsappStatsDto,
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
import { type z } from 'zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  AllowWithoutFeature,
  RequireFeature,
} from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { userCan } from '../../common/guards/permissions.guard';

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

/** El cuerpo de las pruebas es opcional (sin él se prueba lo guardado). */
function parseOptional<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: parsed.error.issues[0]?.message ?? 'Datos no válidos',
    });
  }
  return parsed.data;
}

function meta(req: Request): { ipAddress?: string; userAgent?: string } {
  const ua = req.header('user-agent');
  return { ...(req.ip ? { ipAddress: req.ip } : {}), ...(ua ? { userAgent: ua } : {}) };
}

/**
 * Leer, desactivar y desconectar no exigen el extra (tras bajar de plan se
 * puede consultar y quitar lo guardado); conectar, activar y probar sí (lo
 * comprueba el service o `@RequireFeature`).
 */
@RequireFeature('whatsapp_business')
@Controller('settings/whatsapp')
export class WhatsappSettingsController {
  constructor(
    private readonly settings: WhatsappSettingsService,
    private readonly assistant: WhatsappAssistantService,
  ) {}

  @RequirePermission('settings:read')
  @AllowWithoutFeature()
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappSettingsDto> {
    return this.settings.get(user.tenantId, {
      includeVerifyToken: userCan(user, 'settings:manage'),
    });
  }

  /** Desconecta el número (las conversaciones se conservan). */
  @RequirePermission('settings:manage')
  @AllowWithoutFeature()
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    await this.settings.disconnect({ tenantId: user.tenantId, userId: user.sub, meta: meta(req) });
  }

  @RequirePermission('settings:manage')
  @AllowWithoutFeature()
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
  test(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<WhatsappTestResultDto> {
    return this.settings.test(user.tenantId, parseOptional(TestWhatsappSettingsSchema, body));
  }

  @RequirePermission('settings:read')
  @AllowWithoutFeature()
  @Get('assistant')
  getAssistant(@CurrentUser() user: AuthenticatedUser): Promise<WhatsappAssistantDto> {
    return this.assistant.getForTenant(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @AllowWithoutFeature()
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

  /** Prueba la clave de IA propia del tenant (la escrita, si llega; si no, la guardada). */
  @RequirePermission('settings:manage')
  @Post('assistant/test')
  @HttpCode(HttpStatus.OK)
  testAssistant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<WhatsappAiTestResultDto> {
    return this.assistant.testOwn(user.tenantId, parseOptional(TestWhatsappOwnAiSchema, body));
  }
}

@RequireFeature('whatsapp_business')
@Controller('whatsapp/conversations')
export class WhatsappConversationsController {
  constructor(
    private readonly inbox: WhatsappInboxService,
    private readonly assistant: WhatsappAssistantService,
  ) {}

  @RequirePermission('communications:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId') customerId?: string,
  ): Promise<WhatsappConversationDto[]> {
    const id = customerId && /^[0-9a-f-]{36}$/i.test(customerId) ? customerId : undefined;
    return this.inbox.list(user.tenantId, id ? { customerId: id } : {});
  }

  /** Resumen del WhatsApp (conversaciones, asistente frente a equipo, reservas…). */
  @RequirePermission('communications:read')
  @Get('stats')
  stats(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<WhatsappStatsDto> {
    const n = Number(days ?? 30);
    return this.inbox.stats(
      user.tenantId,
      Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 365) : 30,
    );
  }

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

  /** Borrador de respuesta con IA (gasta una consulta del asistente del panel). */
  @RequirePermission('communications:send')
  @Post(':id/suggest-reply')
  @HttpCode(HttpStatus.OK)
  suggest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ suggestion: string }> {
    return this.assistant.suggestReply(user.tenantId, user.sub, id);
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
