import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PushModule } from '../push/push.module';

import { CustomerMessagesController } from './customer-messages.controller';
import { CustomerMessagesService } from './customer-messages.service';

@Module({
  imports: [NotificationsModule, PushModule],
  controllers: [CustomerMessagesController],
  providers: [CustomerMessagesService],
  exports: [CustomerMessagesService],
})
export class CustomerMessagesModule {}
