import { Global, Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { SecurityEventsCleanupService } from './security-events-cleanup.service';
import { SecurityEventsService } from './security-events.service';

/**
 * Modulo global de eventos de seguridad. Lo marcamos `@Global()` igual que
 * `DatabaseModule` para que `AuthService` y `SessionsService` puedan inyectar
 * `SecurityEventsService` sin importar este modulo en cada parent.
 *
 * Los controllers y las alertas de fuerza bruta (`SecurityAlertsService`, que
 * avisa por los canales del super admin) viven en `AdminModule`.
 *
 * Sub-bloque 14A.1: la limpieza con `@Cron` solo se registra cuando
 * `ENABLE_WORKERS_IN_API=true`.
 */
@Global()
@Module({
  providers: [
    SecurityEventsService,
    ...(WORKERS_ENABLED_IN_API ? [SecurityEventsCleanupService] : []),
  ],
  exports: [SecurityEventsService],
})
export class SecurityEventsModule {}
