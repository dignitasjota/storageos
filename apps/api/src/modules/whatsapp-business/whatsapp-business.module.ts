import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';
import { AuthModule } from '../auth/auth.module';
import { LandingModule } from '../landing/landing.module';
import { LeadsModule } from '../leads/leads.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { WhatsappAiAdminController } from './whatsapp-ai-admin.controller';
import { WhatsappAiClient } from './whatsapp-ai.client';
import { WhatsappAssistantService } from './whatsapp-assistant.service';
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
  // JwtModule vacío + AdminGuard: el controller del panel admin (mismo patrón
  // que BillingSaasModule).
  imports: [AuthModule, LeadsModule, NotificationsModule, LandingModule, JwtModule.register({})],
  controllers: [
    WhatsappSettingsController,
    WhatsappConversationsController,
    WhatsappAiAdminController,
  ],
  providers: [
    WhatsappCloudClient,
    WhatsappAiClient,
    WhatsappSettingsService,
    WhatsappAssistantService,
    WhatsappInboxService,
    AdminGuard,
    SuperAdminAuditService,
  ],
  exports: [WhatsappInboxService, WhatsappSettingsService],
})
export class WhatsappBusinessModule {}
