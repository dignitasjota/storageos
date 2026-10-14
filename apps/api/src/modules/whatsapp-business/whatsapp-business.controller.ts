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
} from '@nestjs/common';
import {
  SendWhatsappMessageSchema,
  UpdateWhatsappSettingsSchema,
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

import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappSettingsService } from './whatsapp-settings.service';

import type { Request } from 'express';

class UpdateWhatsappSettingsBody extends createZodDto(UpdateWhatsappSettingsSchema) {}
class SendWhatsappMessageBody extends createZodDto(SendWhatsappMessageSchema) {}

@RequireFeature('whatsapp_business')
@Controller('settings/whatsapp')
export class WhatsappSettingsController {
  constructor(private readonly settings: WhatsappSettingsService) {}

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
}
