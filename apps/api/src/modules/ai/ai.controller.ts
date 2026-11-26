import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type AiConversationDetailDto,
  type AiScheduledQuestionDto,
  type AiConversationDto,
  type AiPendingActionDto,
  type AiUsageDto,
  ChatSchema,
  type ChatResultDto,
  CreateAiScheduledQuestionSchema,
  UpdateAiScheduledQuestionSchema,
  permissionsForRole,
  SuggestReplySchema,
  type SuggestReplyResultDto,
  type TenantAiSettingsDto,
  type TenantAiTestDto,
  TestTenantAiSettingsSchema,
  UpdateTenantAiSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  AllowWithoutFeature,
  RequireFeature,
} from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AiActionsService } from './ai-actions.service';
import { AiScheduledService } from './ai-scheduled.service';
import { AiService } from './ai.service';

import type { Request, Response } from 'express';

class ChatDto extends createZodDto(ChatSchema) {}
class SuggestReplyDto extends createZodDto(SuggestReplySchema) {}
class UpdateTenantAiSettingsDto extends createZodDto(UpdateTenantAiSettingsSchema) {}
class CreateAiScheduledQuestionDto extends createZodDto(CreateAiScheduledQuestionSchema) {}
class UpdateAiScheduledQuestionDto extends createZodDto(UpdateAiScheduledQuestionSchema) {}

@RequirePermission('ai:use')
@Controller('ai')
@RequireFeature('ai_assistant')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly actions: AiActionsService,
    private readonly scheduled: AiScheduledService,
  ) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  chat(@CurrentUser() user: AuthenticatedUser, @Body() body: ChatDto): Promise<ChatResultDto> {
    return this.ai.chat(chatArgs(user, body));
  }

  /**
   * Chat en streaming (Server-Sent Events). Eventos `data: {…}`:
   * `text` (trozo de respuesta), `tool` (herramienta que se consulta),
   * `done` (conversationId + mensaje guardado) y `error`. Los errores previos
   * a abrir el stream (IA no configurada, validación) responden como siempre.
   */
  @Post('chat/stream')
  async chatStream(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChatDto,
    @Res() res: Response,
  ): Promise<void> {
    this.ai.assertAvailable();
    // Antes de abrir el stream, para que el límite responda con su 429.
    const reservation = await this.ai.reserveChat(user.tenantId, user.sub);
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx (Proxy Manager) no debe retener la respuesta en su buffer.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Si el usuario se va (o pulsa «Detener»), se deja de llamar al modelo.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    // Latido: mientras el modelo piensa no viaja nada y un proxy cortaría la conexión.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 15_000);
    try {
      const result = await this.ai.chatStream(
        chatArgs(user, body),
        {
          onText: (delta) => send({ type: 'text', delta }),
          onTool: (name) => send({ type: 'tool', name }),
          onStart: (conversationId) => send({ type: 'start', conversationId }),
          signal: abort.signal,
        },
        reservation,
      );
      send({ type: 'done', ...result });
    } catch (err) {
      await this.ai.releaseQuota(reservation);
      const response =
        err instanceof HttpException
          ? (err.getResponse() as { code?: string; message?: string })
          : null;
      send({
        type: 'error',
        code: response?.code ?? 'ai_stream_failed',
        message: response?.message ?? 'No se pudo completar la respuesta.',
      });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  /** Consultas del asistente usadas este mes (y las del usuario hoy). */
  @AllowWithoutFeature()
  @Get('usage')
  usage(@CurrentUser() user: AuthenticatedUser): Promise<AiUsageDto> {
    return this.ai.usage(user.tenantId, user.sub);
  }

  /**
   * Clave de IA propia del negocio (se usa al gastar las consultas, o siempre).
   * Leerla y quitarla no exigen el asistente en el plan; ponerla sí (service).
   */
  @RequirePermission('settings:manage')
  @AllowWithoutFeature()
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<TenantAiSettingsDto> {
    return this.ai.tenantSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @AllowWithoutFeature()
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateTenantAiSettingsDto,
  ): Promise<TenantAiSettingsDto> {
    return this.ai.updateTenantSettings(user.tenantId, user.sub, body);
  }

  @RequirePermission('settings:manage')
  @AllowWithoutFeature()
  @Post('settings/test')
  @HttpCode(HttpStatus.OK)
  testSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() raw: unknown,
  ): Promise<TenantAiTestDto> {
    // Cuerpo opcional: con `apiKey` se prueba lo escrito sin guardarlo.
    const parsed = TestTenantAiSettingsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? 'Datos no válidos',
      });
    }
    return this.ai.testOwnKey(user.tenantId, parsed.data);
  }

  /** Confirma una acción propuesta por el asistente: se ejecuta con tus permisos actuales. */
  @Post('actions/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirmAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AiPendingActionDto> {
    return this.actions.confirm({
      tenantId: user.tenantId,
      userId: user.sub,
      permissions: user.permissions ?? permissionsForRole(user.role),
      facilityScope: user.facilityScope ?? null,
      actionId: id,
      meta: {
        ...(req.ip ? { ipAddress: req.ip } : {}),
        ...(req.header('user-agent') ? { userAgent: req.header('user-agent')! } : {}),
      },
    });
  }

  /** Descarta una acción propuesta (no se ejecuta). */
  @Post('actions/:id/discard')
  @HttpCode(HttpStatus.OK)
  discardAction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AiPendingActionDto> {
    return this.actions.discard(user.tenantId, user.sub, id);
  }

  /** Preguntas para empezar según lo que pasa hoy. */
  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthenticatedUser): Promise<string[]> {
    return this.scheduled.suggestions(user);
  }

  // ─── Preguntas programadas (cada una es de quien la creó) ──────────────────

  @Get('scheduled-questions')
  listScheduled(@CurrentUser() user: AuthenticatedUser): Promise<AiScheduledQuestionDto[]> {
    return this.scheduled.list(user);
  }

  @Post('scheduled-questions')
  createScheduled(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAiScheduledQuestionDto,
  ): Promise<AiScheduledQuestionDto> {
    return this.scheduled.create(user, body);
  }

  @Patch('scheduled-questions/:id')
  updateScheduled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAiScheduledQuestionDto,
  ): Promise<AiScheduledQuestionDto> {
    return this.scheduled.update(user, id, body);
  }

  @Delete('scheduled-questions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeScheduled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.scheduled.remove(user, id);
  }

  /** La hace ya y manda el correo (5 por minuto: gasta una consulta). */
  @Post('scheduled-questions/:id/send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sendScheduled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AiScheduledQuestionDto> {
    return this.scheduled.sendNow(user, id);
  }

  /** Redacta (no envía) una respuesta sugerida para el chat con un inquilino. */
  @RequirePermission('ai:use', 'customers:read')
  @Post('suggest-reply')
  @HttpCode(HttpStatus.OK)
  suggestReply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SuggestReplyDto,
  ): Promise<SuggestReplyResultDto> {
    return this.ai.suggestReply({
      tenantId: user.tenantId,
      customerId: body.customerId,
      userId: user.sub,
      facilityScope: user.facilityScope ?? null,
      money: (user.permissions ?? permissionsForRole(user.role)).includes('invoices:read'),
    });
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthenticatedUser): Promise<AiConversationDto[]> {
    return this.ai.listConversations(user.tenantId, user.sub);
  }

  @Get('conversations/:id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AiConversationDetailDto> {
    return this.ai.getConversation(user.tenantId, user.sub, id);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.ai.deleteConversation(user.tenantId, user.sub, id);
  }
}

function chatArgs(user: AuthenticatedUser, body: ChatDto) {
  return {
    tenantId: user.tenantId,
    userId: user.sub,
    // Tokens antiguos sin claim `permissions` → los del rol (como PermissionsGuard).
    permissions: user.permissions ?? permissionsForRole(user.role),
    facilityScope: user.facilityScope ?? null,
    input: body,
  };
}
