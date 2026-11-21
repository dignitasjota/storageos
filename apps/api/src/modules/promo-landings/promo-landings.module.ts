import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { LandingModule } from '../landing/landing.module';

import { PromoLandingsController } from './promo-landings.controller';
import { PromoLandingsService } from './promo-landings.service';

@Module({
  imports: [AuthModule, AiModule, LandingModule],
  controllers: [PromoLandingsController],
  providers: [PromoLandingsService],
})
export class PromoLandingsModule {}
