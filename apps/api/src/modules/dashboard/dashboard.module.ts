import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_EMAIL } from '../queues/queue-names';

import { DailySummaryService } from './daily-summary.service';
import { DashboardController } from './dashboard.controller';
import { OnboardingService } from './onboarding.service';
import { TodaySummaryService } from './today-summary.service';
import { TodayService } from './today.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_EMAIL })],
  controllers: [DashboardController],
  // El resumen del día corre en el API sin gatear: es ligero (encola correos)
  // y reserva el día por negocio con un `updateMany` condicionado.
  providers: [TodayService, OnboardingService, TodaySummaryService, DailySummaryService],
})
export class DashboardModule {}
