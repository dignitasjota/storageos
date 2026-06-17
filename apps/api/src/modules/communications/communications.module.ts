import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';

import { CommunicationsController } from './communications.controller';
import { CommunicationsProcessor } from './communications.processor';
import { CommunicationsService } from './communications.service';
import { MessageTemplatesController } from './message-templates.controller';
import { MessageTemplatesService } from './message-templates.service';
import { MetaWabaProvider } from './providers/meta-waba.provider';
import { WHATSAPP_PROVIDER } from './providers/whatsapp-provider';
import { WhatsAppStubProvider } from './providers/whatsapp-stub.provider';

import type { Env } from '../../config/env.schema';

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
    MetaWabaProvider,
    {
      // `stub` por defecto (dev/test); `meta_waba` en producción.
      provide: WHATSAPP_PROVIDER,
      useFactory: (
        config: ConfigService<Env, true>,
        stub: WhatsAppStubProvider,
        meta: MetaWabaProvider,
      ) => (config.get('WHATSAPP_PROVIDER', { infer: true }) === 'meta_waba' ? meta : stub),
      inject: [ConfigService, WhatsAppStubProvider, MetaWabaProvider],
    },
    ...(WORKERS_ENABLED_IN_API ? [CommunicationsProcessor] : []),
  ],
  exports: [CommunicationsService, MessageTemplatesService],
})
export class CommunicationsModule {}
