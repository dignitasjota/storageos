import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { WaitlistPublicController } from './waitlist-public.controller';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [AuthModule, CommunicationsModule, NotificationsModule],
  controllers: [WaitlistController, WaitlistPublicController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
