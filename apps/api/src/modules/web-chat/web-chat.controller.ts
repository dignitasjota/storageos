import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  PublicWebChatContactSchema,
  PublicWebChatFeedbackSchema,
  PublicWebChatHandoffSchema,
  PublicWebChatSchema,
  UpdateWebChatConversationSchema,
  UpdateWebChatSettingsSchema,
  WebChatStaffReplySchema,
  WebChatVisitorIdSchema,
  type WebChatPendingDto,
  type PublicWebChatHistoryDto,
  type PublicWebChatResultDto,
  type WebChatConversationDto,
  type WebChatMessageDto,
  type WebChatSettingsDto,
  type WebChatStatsDto,
  type PageDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { parsePageRequest } from '../../common/pagination';

import { WebChatService } from './web-chat.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { Request, Response } from 'express';

class PublicWebChatDto extends createZodDto(PublicWebChatSchema) {}
class WebChatHistoryDto extends createZodDto(
  z.object({ visitorId: WebChatVisitorIdSchema, locale: z.enum(['es', 'en']).default('es') }),
) {}
class WebChatHandoffDto extends createZodDto(PublicWebChatHandoffSchema) {}
class WebChatFeedbackDto extends createZodDto(PublicWebChatFeedbackSchema) {}
class WebChatContactBodyDto extends createZodDto(PublicWebChatContactSchema) {}
class WebChatStaffReplyDto extends createZodDto(WebChatStaffReplySchema) {}
class UpdateWebChatConversationDto extends createZodDto(UpdateWebChatConversationSchema) {}
class UpdateWebChatSettingsDto extends createZodDto(UpdateWebChatSettingsSchema) {}

const days = (v?: string) => Math.min(365, Math.max(1, Number(v) || 30));

/** Chat con IA de la web pública (visitantes anónimos). */
@Public()
@Controller({ path: 'public/landing', version: VERSION_NEUTRAL })
export class WebChatPublicController {
  constructor(private readonly chat: WebChatService) {}

  @Post(':slug/chat')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  answer(
    @Param('slug') slug: string,
    @Body() body: PublicWebChatDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicWebChatResultDto> {
    return this.chat.answer(slug, body, { ipAddress: ip, userAgent });
  }

  /** La conversación del visitante (para volver a pintarla al recargar). */
  @Post(':slug/chat/history')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  history(
    @Param('slug') slug: string,
    @Body() body: WebChatHistoryDto,
  ): Promise<PublicWebChatHistoryDto> {
    return this.chat.history(slug, body.visitorId, body.locale);
  }

  /**
   * Igual que `chat`, pero la respuesta llega por partes (eventos SSE `text`
   * con cada trozo y `done` con el resultado final, ya sin marcas).
   */
  @Post(':slug/chat/stream')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async answerStream(
    @Param('slug') slug: string,
    @Body() body: PublicWebChatDto,
    @Ip() ip: string,
    @Res() res: Response,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    // Antes de abrir el stream, para que un chat apagado responda con su 404.
    await this.chat.liveTenant(slug);
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      const result = await this.chat.answer(slug, body, { ipAddress: ip, userAgent }, (delta) =>
        send({ type: 'text', delta }),
      );
      send({ type: 'done', ...result });
    } catch {
      send({ type: 'error' });
    } finally {
      res.end();
    }
  }

  /** El visitante pide hablar con una persona del equipo. */
  @Post(':slug/chat/handoff')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  handoff(
    @Param('slug') slug: string,
    @Body() body: WebChatHandoffDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicWebChatResultDto> {
    return this.chat.requestHandoff(slug, body, { ipAddress: ip, userAgent });
  }

  /** Datos de contacto si nadie del equipo responde a tiempo. */
  @Post(':slug/chat/contact')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  contact(
    @Param('slug') slug: string,
    @Body() body: WebChatContactBodyDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<{ saved: boolean }> {
    return this.chat.leaveContact(slug, body, { ipAddress: ip, userAgent });
  }

  /** 👍/👎 a una respuesta del asistente. */
  @Post(':slug/chat/feedback')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  feedback(
    @Param('slug') slug: string,
    @Body() body: WebChatFeedbackDto,
  ): Promise<{ saved: boolean }> {
    return this.chat.rate(slug, body);
  }
}

/** Ajustes y conversaciones del chat de la web (panel del tenant). */
@Controller('web-chat')
export class WebChatController {
  constructor(private readonly chat: WebChatService) {}

  @RequirePermission('settings:read')
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<WebChatSettingsDto> {
    return this.chat.settings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch('settings')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateWebChatSettingsDto,
    @Req() req: Request,
  ): Promise<WebChatSettingsDto> {
    return this.chat.updateSettings(user.tenantId, body, {
      userId: user.sub,
      meta: { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    });
  }

  @RequirePermission('marketing:read')
  @Get('stats')
  stats(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') d?: string,
  ): Promise<WebChatStatsDto> {
    return this.chat.stats(user.tenantId, days(d));
  }

  /** Conversaciones con mensajes en el periodo, por cursor (la última primero). */
  @RequirePermission('marketing:read')
  @Get('conversations/page')
  conversations(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') d?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('mode') mode?: string,
  ): Promise<PageDto<WebChatConversationDto>> {
    return this.chat.conversations(user.tenantId, days(d), parsePageRequest(cursor, limit), {
      ...(mode === 'human' || mode === 'ai' ? { mode } : {}),
    });
  }

  /** Conversaciones esperando a una persona (menú y bandeja de mensajes). */
  @RequirePermission('marketing:read')
  @Get('pending')
  pending(@CurrentUser() user: AuthenticatedUser): Promise<WebChatPendingDto> {
    return this.chat.pending(user.tenantId);
  }

  /** Respuesta de una persona del equipo al visitante. */
  @RequirePermission('communications:send')
  @Post('conversations/:id/messages')
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WebChatStaffReplyDto,
  ): Promise<WebChatMessageDto[]> {
    return this.chat.staffReply(user.tenantId, id, user.sub, body.body);
  }

  /** Devuelve la conversación al asistente (`ai`) o la pasa al equipo (`human`). */
  @RequirePermission('communications:send')
  @Patch('conversations/:id')
  setMode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWebChatConversationDto,
  ): Promise<{ mode: 'ai' | 'human' }> {
    return this.chat.setMode(user.tenantId, id, body.mode);
  }

  /** Borrador de respuesta con IA (gasta una consulta del asistente del panel). */
  @RequirePermission('communications:send')
  @Post('conversations/:id/suggest-reply')
  @HttpCode(HttpStatus.OK)
  suggest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ suggestion: string }> {
    return this.chat.suggestReply(user.tenantId, user.sub, id);
  }

  @RequirePermission('marketing:read')
  @Get('conversations/:id')
  messages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebChatMessageDto[]> {
    return this.chat.messages(user.tenantId, id);
  }
}
