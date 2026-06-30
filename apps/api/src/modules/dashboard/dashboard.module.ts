import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { TodayService } from './today.service';

@Module({
  controllers: [DashboardController],
  providers: [TodayService],
})
export class DashboardModule {}
