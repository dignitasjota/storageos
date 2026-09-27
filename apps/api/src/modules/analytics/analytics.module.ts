import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { BenchmarkService } from './benchmark.service';
import { InsightsService } from './insights.service';
import { SuggestedActionsService } from './suggested-actions.service';

@Module({
  imports: [AuthModule, AiModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, InsightsService, BenchmarkService, SuggestedActionsService],
  exports: [AnalyticsService, InsightsService],
})
export class AnalyticsModule {}
