import { Module } from '@nestjs/common';

import { PushStaffController } from './push-staff.controller';
import { PushService } from './push.service';

/**
 * Notificaciones Web Push para el inquilino y para el equipo. Registra los
 * listeners de eventos (`@OnEvent`) que avisan al inquilino de sus facturas.
 * `PushService` se exporta para que `PortalModule` exponga los endpoints de
 * suscripción del inquilino y `NotificationsModule` avise al equipo; los del
 * equipo están en `PushStaffController` (`/me/push`).
 */
@Module({
  controllers: [PushStaffController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
