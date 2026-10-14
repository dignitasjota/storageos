import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { LeadsModule } from '../leads/leads.module';
import { NotificationsModule } from '../notifications/notifications.module';

import {
  WhatsappConversationsController,
  WhatsappSettingsController,
} from './whatsapp-business.controller';
import { WhatsappCloudClient } from './whatsapp-cloud.client';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappSettingsService } from './whatsapp-settings.service';

/**
 * Extra «WhatsApp Business»: número de WhatsApp del tenant (Cloud API de
 * Meta), bandeja de conversaciones en el panel y botón en su web. El webhook
 * de entrada vive en `InboundMessagesModule` (URL única de la app de Meta) y
 * delega aquí los mensajes dirigidos al número de un tenant.
 */
@Module({
  imports: [AuthModule, LeadsModule, NotificationsModule],
  controllers: [WhatsappSettingsController, WhatsappConversationsController],
  providers: [WhatsappCloudClient, WhatsappSettingsService, WhatsappInboxService],
  exports: [WhatsappInboxService, WhatsappSettingsService],
})
export class WhatsappBusinessModule {}
