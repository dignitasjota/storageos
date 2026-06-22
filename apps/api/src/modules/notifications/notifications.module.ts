import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Notificaciones in-app (feed de actividad del tenant). Escucha eventos de
 * dominio y los registra; el panel los muestra en el bell del header.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
