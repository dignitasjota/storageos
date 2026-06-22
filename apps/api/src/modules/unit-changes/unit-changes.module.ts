import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { UnitChangesController } from './unit-changes.controller';
import { UnitChangesService } from './unit-changes.service';

/**
 * Solicitudes de cambio/upgrade de trastero del inquilino (portal) gestionadas
 * por el staff. `NotificationsModule` para avisar al staff de cada solicitud.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [UnitChangesController],
  providers: [UnitChangesService],
  exports: [UnitChangesService],
})
export class UnitChangesModule {}
