import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';

import { EmailEventsController } from './email-events.controller';
import { EmailEventsService } from './email-events.service';

/** Avisos de entrega de Brevo/Resend → estado real de cada comunicación. */
@Module({
  imports: [NotificationsModule],
  controllers: [EmailEventsController],
  providers: [EmailEventsService],
})
export class EmailEventsModule {}
