import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';

import { AnalyticsTrendsService } from './analytics-trends.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { BenchmarkService } from './benchmark.service';
import { InsightsService } from './insights.service';
import { SuggestedActionsService } from './suggested-actions.service';

@Module({
  imports: [AuthModule, AiModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsTrendsService,
    InsightsService,
    BenchmarkService,
    SuggestedActionsService,
  ],
  exports: [AnalyticsService, AnalyticsTrendsService, InsightsService],
})
export class AnalyticsModule {}
