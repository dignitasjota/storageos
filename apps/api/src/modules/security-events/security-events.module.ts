import { Global, Module } from '@nestjs/common';

import { SecurityEventsCleanupService } from './security-events-cleanup.service';
import { SecurityEventsService } from './security-events.service';

/**
 * Modulo global de eventos de seguridad. Lo marcamos `@Global()` igual que
 * `DatabaseModule` para que `AuthService` y `SessionsService` puedan inyectar
 * `SecurityEventsService` sin importar este modulo en cada parent.
 *
 * El controller `SecurityEventsController` vive en `AdminModule` para
 * compartir el `AdminGuard` y la convencion `/admin/...` de Fase 8.
 */
@Global()
@Module({
  providers: [SecurityEventsService, SecurityEventsCleanupService],
  exports: [SecurityEventsService],
})
export class SecurityEventsModule {}
