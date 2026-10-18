import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';
import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { WaitlistExpiryCron } from './waitlist-expiry.cron';
import { WaitlistPublicController } from './waitlist-public.controller';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [AuthModule, CommunicationsModule, NotificationsModule],
  controllers: [WaitlistController, WaitlistPublicController],
  providers: [WaitlistService, ...(WORKERS_ENABLED_IN_API ? [WaitlistExpiryCron] : [])],
  exports: [WaitlistService],
})
export class WaitlistModule {}
