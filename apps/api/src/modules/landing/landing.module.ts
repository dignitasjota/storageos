import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { LeadsModule } from '../leads/leads.module';

import { LandingController } from './landing.controller';
import { LandingService } from './landing.service';
import { WebLegalController } from './web-legal.controller';
import { WebLegalService } from './web-legal.service';

@Module({
  imports: [LeadsModule, AuthModule],
  controllers: [LandingController, WebLegalController],
  providers: [LandingService, WebLegalService],
  exports: [LandingService],
})
export class LandingModule {}
