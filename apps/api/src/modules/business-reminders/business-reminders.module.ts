import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { ExpensesModule } from '../expenses/expenses.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QUEUE_EMAIL } from '../queues/queue-names';

import { BusinessReminderNoticesService } from './business-reminder-notices.service';
import { BusinessRemindersCalendarController } from './business-reminders-calendar.controller';
import { BusinessRemindersController } from './business-reminders.controller';
import { BusinessRemindersService } from './business-reminders.service';

/**
 * Vencimientos del negocio. Los avisos corren en el API sin gatear (como el
 * resumen del día): son ligeros y se reservan uno a uno en BD.
 */
@Module({
  imports: [ExpensesModule, NotificationsModule, BullModule.registerQueue({ name: QUEUE_EMAIL })],
  controllers: [BusinessRemindersController, BusinessRemindersCalendarController],
  providers: [BusinessRemindersService, BusinessReminderNoticesService],
  exports: [BusinessRemindersService],
})
export class BusinessRemindersModule {}
