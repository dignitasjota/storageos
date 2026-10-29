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
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  PublicWebChatSchema,
  UpdateWebChatSettingsSchema,
  WebChatVisitorIdSchema,
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
import type { Request } from 'express';

class PublicWebChatDto extends createZodDto(PublicWebChatSchema) {}
class WebChatHistoryDto extends createZodDto(z.object({ visitorId: WebChatVisitorIdSchema })) {}
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
    return this.chat.history(slug, body.visitorId);
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
  ): Promise<PageDto<WebChatConversationDto>> {
    return this.chat.conversations(user.tenantId, days(d), parsePageRequest(cursor, limit));
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
