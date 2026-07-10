import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { WaitlistPublicController } from './waitlist-public.controller';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [AuthModule, EmailModule, NotificationsModule],
  controllers: [WaitlistController, WaitlistPublicController],
  providers: [WaitlistService],
})
export class WaitlistModule {}
