import { Module } from '@nestjs/common';

import { LeadsModule } from '../leads/leads.module';

import { LandingController } from './landing.controller';
import { LandingService } from './landing.service';

@Module({
  imports: [LeadsModule],
  controllers: [LandingController],
  providers: [LandingService],
})
export class LandingModule {}
