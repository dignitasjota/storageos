import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { DataRetentionCron } from './data-retention.cron';
import { DataRetentionService } from './data-retention.service';

/**
 * Retención de datos. `PrismaAdminService` es global (no hace falta importarlo).
 * El cron solo se registra cuando `WORKERS_ENABLED_IN_API` (dev/test/worker),
 * como el resto de crons de mantenimiento, para no ejecutarlo dos veces en prod.
 */
@Module({
  providers: [DataRetentionService, ...(WORKERS_ENABLED_IN_API ? [DataRetentionCron] : [])],
  exports: [DataRetentionService],
})
export class DataRetentionModule {}
