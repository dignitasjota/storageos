import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { PushStaffController } from './push-staff.controller';
import { PushService } from './push.service';
import { SuperAdminPushCron } from './super-admin-push.cron';
import { SuperAdminPushService } from './super-admin-push.service';

/**
 * Notificaciones Web Push para el inquilino y para el equipo. Registra los
 * listeners de eventos (`@OnEvent`) que avisan al inquilino de sus facturas.
 * `PushService` se exporta para que `PortalModule` exponga los endpoints de
 * suscripción del inquilino y `NotificationsModule` avise al equipo; los del
 * equipo están en `PushStaffController` (`/me/push`). El push del super admin
 * (`SuperAdminPushService`) lo expone `AdminModule`; su tarea de cada minuto
 * corre donde corren los workers.
 */
@Module({
  controllers: [PushStaffController],
  providers: [
    PushService,
    SuperAdminPushService,
    ...(WORKERS_ENABLED_IN_API ? [SuperAdminPushCron] : []),
  ],
  exports: [PushService, SuperAdminPushService],
})
export class PushModule {}
