import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';

import { CompetitorsMarketService } from './competitors-market.service';
import { CompetitorsController } from './competitors.controller';
import { CompetitorsService } from './competitors.service';

/** Fichar la competencia (locales + trasteros) para el pricing por competencia. */
@Module({
  imports: [AuthModule, AiModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsService, CompetitorsMarketService],
  exports: [CompetitorsService],
})
export class CompetitorsModule {}
