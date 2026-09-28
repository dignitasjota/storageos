import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  type AiConversationDetailDto,
  type AiConversationDto,
  type AiPendingActionDto,
  ChatSchema,
  type ChatResultDto,
  permissionsForRole,
  SuggestReplySchema,
  type SuggestReplyResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AiActionsService } from './ai-actions.service';
import { AiService } from './ai.service';

import type { Request, Response } from 'express';

class ChatDto extends createZodDto(ChatSchema) {}
class SuggestReplyDto extends createZodDto(SuggestReplySchema) {}

@RequirePermission('ai:use')
@Controller('ai')
@RequireFeature('ai_assistant')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly actions: AiActionsService,
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
    try {
      const result = await this.ai.chatStream(chatArgs(user, body), {
        onText: (delta) => send({ type: 'text', delta }),
        onTool: (name) => send({ type: 'tool', name }),
      });
      send({ type: 'done', ...result });
    } catch (err) {
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
      res.end();
    }
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

  /** Redacta (no envía) una respuesta sugerida para el chat con un inquilino. */
  @Post('suggest-reply')
  @HttpCode(HttpStatus.OK)
  suggestReply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SuggestReplyDto,
  ): Promise<SuggestReplyResultDto> {
    return this.ai.suggestReply({ tenantId: user.tenantId, customerId: body.customerId });
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
