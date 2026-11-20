import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { PromoLandingsController } from './promo-landings.controller';
import { PromoLandingsService } from './promo-landings.service';

@Module({
  imports: [AuthModule],
  controllers: [PromoLandingsController],
  providers: [PromoLandingsService],
})
export class PromoLandingsModule {}
