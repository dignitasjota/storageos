import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PushModule } from '../push/push.module';

import { CustomerConversationsService } from './customer-conversations.service';
import { CustomerMessagesReminderCron } from './customer-messages-reminder.cron';
import { CustomerMessagesSummaryController } from './customer-messages-summary.controller';
import { CustomerMessagesController } from './customer-messages.controller';
import { CustomerMessagesService } from './customer-messages.service';

@Module({
  imports: [NotificationsModule, PushModule],
  controllers: [CustomerMessagesController, CustomerMessagesSummaryController],
  providers: [CustomerMessagesService, CustomerConversationsService, CustomerMessagesReminderCron],
  exports: [CustomerMessagesService],
})
export class CustomerMessagesModule {}
