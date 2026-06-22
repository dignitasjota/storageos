import { Module } from '@nestjs/common';

import { PushService } from './push.service';

/**
 * Notificaciones Web Push para el inquilino. Registra los listeners de eventos
 * (`@OnEvent`) que avisan al inquilino de sus facturas. `PushService` se exporta
 * para que `PortalModule` exponga los endpoints de suscripción.
 */
@Module({
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
