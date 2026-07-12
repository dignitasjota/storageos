import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AnalyticsModule } from '../analytics/analytics.module';
import { QUEUE_EMAIL } from '../queues/queue-names';

import { TenantDigestController } from './tenant-digest.controller';
import { TenantMonthlyDigestCron } from './tenant-monthly-digest.cron';
import { TenantMonthlyDigestService } from './tenant-monthly-digest.service';

/** Informe mensual del negocio por email al operador (opt-in). */
@Module({
  imports: [AnalyticsModule, BullModule.registerQueue({ name: QUEUE_EMAIL })],
  controllers: [TenantDigestController],
  // El cron corre en el API sin gatear (ligero; encola emails y se deduplica
  // con `claimDailyCronRun`), como platform-dunning / weekly-digest.
  providers: [TenantMonthlyDigestService, TenantMonthlyDigestCron],
  exports: [TenantMonthlyDigestService],
})
export class TenantDigestModule {}
