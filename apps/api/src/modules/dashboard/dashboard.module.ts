import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { CollectionsModule } from '../collections/collections.module';
import { CollectionsOpsModule } from '../collections-ops/collections-ops.module';
import { ContractsModule } from '../contracts/contracts.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MoveInModule } from '../move-in/move-in.module';
import { PushModule } from '../push/push.module';
import { QUEUE_EMAIL } from '../queues/queue-names';

import { DailySummaryService } from './daily-summary.service';
import { DashboardOverviewService } from './dashboard-overview.service';
import { DashboardController } from './dashboard.controller';
import { OnboardingTestRunService } from './onboarding-test-run.service';
import { OnboardingService } from './onboarding.service';
import { TodayExtrasService } from './today-extras.service';
import { TodaySummaryService } from './today-summary.service';
import { TodayService } from './today.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_EMAIL }),
    AccessModule,
    AnalyticsModule,
    AuthModule,
    CollectionsModule,
    CollectionsOpsModule,
    ContractsModule,
    InventoryModule,
    MoveInModule,
    PushModule,
  ],
  controllers: [DashboardController],
  // El resumen del día corre en el API sin gatear: es ligero (encola correos)
  // y reserva el día por negocio con un `updateMany` condicionado.
  providers: [
    TodayService,
    TodayExtrasService,
    OnboardingService,
    OnboardingTestRunService,
    TodaySummaryService,
    DashboardOverviewService,
    DailySummaryService,
  ],
})
export class DashboardModule {}
