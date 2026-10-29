import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { LandingModule } from '../landing/landing.module';
import { LeadsModule } from '../leads/leads.module';

import { WebChatController, WebChatPublicController } from './web-chat.controller';
import { WebChatService } from './web-chat.service';

/** Chat con IA de la web pública del tenant. */
@Module({
  imports: [AuthModule, AiModule, LandingModule, LeadsModule],
  controllers: [WebChatPublicController, WebChatController],
  providers: [WebChatService],
})
export class WebChatModule {}
