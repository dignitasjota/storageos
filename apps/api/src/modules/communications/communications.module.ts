import { Global, Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
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
 *
 * Sub-bloque 14A.1: `CommunicationsProcessor` solo se registra cuando
 * `ENABLE_WORKERS_IN_API=true`. El `CommunicationsService` sigue activo
 * siempre porque otros modulos lo inyectan para encolar envios.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [CommunicationsController, MessageTemplatesController],
  providers: [
    CommunicationsService,
    MessageTemplatesService,
    WhatsAppStubProvider,
    {
      provide: WHATSAPP_PROVIDER,
      useExisting: WhatsAppStubProvider,
    },
    ...(WORKERS_ENABLED_IN_API ? [CommunicationsProcessor] : []),
  ],
  exports: [CommunicationsService, MessageTemplatesService],
})
export class CommunicationsModule {}
