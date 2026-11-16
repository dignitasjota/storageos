import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CommunicationsModule } from '../communications/communications.module';
import { LandingModule } from '../landing/landing.module';
import { LeadsModule } from '../leads/leads.module';
import { MoveInModule } from '../move-in/move-in.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WaitlistModule } from '../waitlist/waitlist.module';

import { WebChatAbuseService } from './web-chat-abuse.service';
import { WebChatWeeklyCron } from './web-chat-weekly.cron';
import { WebChatController, WebChatPublicController } from './web-chat.controller';
import { WebChatService } from './web-chat.service';

/** Chat con IA de la web pública del tenant. */
@Module({
  imports: [
    AuthModule,
    AiModule,
    CommunicationsModule,
    LandingModule,
    LeadsModule,
    MoveInModule,
    NotificationsModule,
    WaitlistModule,
  ],
  controllers: [WebChatPublicController, WebChatController],
  providers: [WebChatService, WebChatAbuseService, WebChatWeeklyCron],
})
export class WebChatModule {}
