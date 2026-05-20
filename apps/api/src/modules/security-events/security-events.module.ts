import { Global, Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { SecurityAlertsCron } from './security-alerts.cron';
import { SecurityAlertsService } from './security-alerts.service';
import { SecurityEventsCleanupService } from './security-events-cleanup.service';
import { SecurityEventsService } from './security-events.service';

/**
 * Modulo global de eventos de seguridad. Lo marcamos `@Global()` igual que
 * `DatabaseModule` para que `AuthService` y `SessionsService` puedan inyectar
 * `SecurityEventsService` sin importar este modulo en cada parent.
 *
 * El controller `SecurityEventsController` y `SecurityAlertsController`
 * viven en `AdminModule` para compartir el `AdminGuard` y la convencion
 * `/admin/...` de Fase 8.
 *
 * `SecurityAlertsService` se inyecta con `EMAIL_PROVIDER` (EmailModule es
 * global) y `PrismaAdminService` (DatabaseModule es global).
 *
 * Sub-bloque 14A.1: las clases con `@Cron` (`SecurityAlertsCron` y
 * `SecurityEventsCleanupService`) solo se registran cuando
 * `ENABLE_WORKERS_IN_API=true`. Los services base (`SecurityEventsService`,
 * `SecurityAlertsService`) siguen activos en el API HTTP-only porque los
 * controllers admin los consultan en lectura.
 */
@Global()
@Module({
  providers: [
    SecurityEventsService,
    SecurityAlertsService,
    ...(WORKERS_ENABLED_IN_API ? [SecurityEventsCleanupService, SecurityAlertsCron] : []),
  ],
  exports: [SecurityEventsService, SecurityAlertsService],
})
export class SecurityEventsModule {}
