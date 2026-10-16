import { Module } from '@nestjs/common';

import { PromoLandingsController } from './promo-landings.controller';
import { PromoLandingsService } from './promo-landings.service';

@Module({
  controllers: [PromoLandingsController],
  providers: [PromoLandingsService],
})
export class PromoLandingsModule {}
