import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';

import { ApiKeysService } from './api-keys.service';
import { IntegrationsApiController } from './integrations-api.controller';
import { IntegrationsController } from './integrations.controller';
import { WebhooksCleanupService } from './webhooks-cleanup.service';
import { WebhooksDispatcherService } from './webhooks-dispatcher.service';
import { WebhooksProcessor } from './webhooks.processor';
import { WebhooksService } from './webhooks.service';

/**
 * Modulo de integraciones externas (Fase 14A.3):
 *   - `ApiKeysService` / `ApiKeyGuard`: tokens Bearer alternativos al JWT.
 *   - `WebhooksService` + `WebhooksDispatcherService` + `WebhooksProcessor`:
 *     entrega de eventos de dominio a URLs registradas por el tenant,
 *     firmados con HMAC SHA-256 y con retry exponencial BullMQ.
 *
 * `WebhooksProcessor` solo se registra cuando `ENABLE_WORKERS_IN_API=true`
 * (mismo patron que CommunicationsModule / AutomationsModule). El
 * dispatcher (listener de eventos) corre siempre porque no entrega: solo
 * crea filas + encola.
 */
@Module({
  imports: [AuthModule],
  controllers: [IntegrationsController, IntegrationsApiController],
  providers: [
    ApiKeysService,
    ApiKeyGuard,
    WebhooksService,
    WebhooksDispatcherService,
    ...(WORKERS_ENABLED_IN_API ? [WebhooksProcessor, WebhooksCleanupService] : []),
  ],
  exports: [ApiKeysService, WebhooksService],
})
export class IntegrationsModule {}
