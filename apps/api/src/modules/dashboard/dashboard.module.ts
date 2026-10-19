import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { OnboardingService } from './onboarding.service';
import { TodaySummaryService } from './today-summary.service';
import { TodayService } from './today.service';

@Module({
  controllers: [DashboardController],
  providers: [TodayService, OnboardingService, TodaySummaryService],
})
export class DashboardModule {}
