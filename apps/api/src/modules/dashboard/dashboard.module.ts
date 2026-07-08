import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { OnboardingService } from './onboarding.service';
import { TodayService } from './today.service';

@Module({
  controllers: [DashboardController],
  providers: [TodayService, OnboardingService],
})
export class DashboardModule {}
