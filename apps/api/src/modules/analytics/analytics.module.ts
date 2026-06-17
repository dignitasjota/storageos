import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { InsightsService } from './insights.service';

@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, InsightsService],
  exports: [AnalyticsService, InsightsService],
})
export class AnalyticsModule {}
