import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import {
  type ChatAlertSendResultDto,
  type ChatAlertSettingsDto,
  UpdateChatAlertSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminGuard } from './admin.guard';
import { ChatAlertsService } from './chat-alerts.service';
import { RequireSuperadmin } from './require-superadmin.decorator';

class UpdateChatAlertSettingsDto extends createZodDto(UpdateChatAlertSettingsSchema) {}

/** Avisos del panel admin por Telegram y Slack. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/chat-alerts')
export class ChatAlertsController {
  constructor(private readonly chat: ChatAlertsService) {}

  @Get()
  get(): Promise<ChatAlertSettingsDto> {
    return this.chat.getSettings();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.chat_alerts.settings_updated')
  @Put()
  update(@Body() input: UpdateChatAlertSettingsDto): Promise<ChatAlertSettingsDto> {
    return this.chat.updateSettings(input);
  }

  @RequireSuperadmin()
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(): Promise<ChatAlertSendResultDto> {
    return this.chat.sendTest();
  }

  /** Manda ya lo urgente del «Hoy» (aunque el aviso diario esté apagado). */
  @RequireSuperadmin()
  @Post('daily/run')
  @HttpCode(HttpStatus.OK)
  runDaily(): Promise<ChatAlertSendResultDto> {
    return this.chat.sendDaily(true);
  }
}
