import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AdminGuard } from '../admin/admin.guard';
import { SuperAdminAuditService } from '../admin/super-admin-audit.service';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { CustomerMessagesModule } from '../customer-messages/customer-messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OperationsModule } from '../operations/operations.module';

import { AiActionsService } from './ai-actions.service';
import { AiAdminController } from './ai-admin.controller';
import { AI_PROVIDER } from './ai-provider';
import { AiQuotaService } from './ai-quota.service';
import { AiToolsService } from './ai-tools.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { DelegatingAiProvider } from './delegating-ai-provider';
import { PlatformAiSettingsService } from './platform-ai-settings.service';

import type { Env } from '../../config/env.schema';

/**
 * Asistente IA para staff. La clave y el modelo salen del panel admin o, si
 * no, de las variables de entorno (sin ninguna, modo demo; en tests, siempre). `AuthModule` para la
 * cadena de guards. Las herramientas (AiToolsService) son de solo lectura y se
 * ejecutan con el contexto del tenant (RLS).
 */
@Module({
  // Operations/Billing/CustomerMessages: para EJECUTAR las acciones confirmadas.
  imports: [
    AuthModule,
    OperationsModule,
    BillingModule,
    CustomerMessagesModule,
    NotificationsModule,
    JwtModule.register({}),
  ],
  controllers: [AiController, AiAdminController],
  providers: [
    AiService,
    AiToolsService,
    AiActionsService,
    PlatformAiSettingsService,
    AiQuotaService,
    AdminGuard,
    SuperAdminAuditService,
    {
      provide: AI_PROVIDER,
      inject: [PlatformAiSettingsService, ConfigService],
      useFactory: (settings: PlatformAiSettingsService, config: ConfigService<Env, true>) =>
        new DelegatingAiProvider(settings, config.get('NODE_ENV', { infer: true }) === 'test'),
    },
  ],
  exports: [AiService, PlatformAiSettingsService, AiQuotaService],
})
export class AiModule {}
