import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { UnitRequestsController } from './unit-requests.controller';
import { UnitRequestsService } from './unit-requests.service';

/**
 * Solicitudes de trastero adicional del inquilino (portal) gestionadas por el
 * staff. El inquilino ve la disponibilidad de su local y manda una solicitud.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [UnitRequestsController],
  providers: [UnitRequestsService],
  exports: [UnitRequestsService],
})
export class UnitRequestsModule {}
