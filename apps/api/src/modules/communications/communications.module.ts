import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { CommunicationsController } from './communications.controller';
import { CommunicationsProcessor } from './communications.processor';
import { CommunicationsService } from './communications.service';
import { MessageTemplatesController } from './message-templates.controller';
import { MessageTemplatesService } from './message-templates.service';
import { WHATSAPP_PROVIDER } from './providers/whatsapp-provider';
import { WhatsAppStubProvider } from './providers/whatsapp-stub.provider';

/**
 * Modulo global de comunicaciones. Exporta `CommunicationsService` y
 * `MessageTemplatesService` para que otros modulos (dunning, automations,
 * auth, portal, contracts) puedan enqueuear envios.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [CommunicationsController, MessageTemplatesController],
  providers: [
    CommunicationsService,
    MessageTemplatesService,
    CommunicationsProcessor,
    WhatsAppStubProvider,
    {
      provide: WHATSAPP_PROVIDER,
      useExisting: WhatsAppStubProvider,
    },
  ],
  exports: [CommunicationsService, MessageTemplatesService],
})
export class CommunicationsModule {}
