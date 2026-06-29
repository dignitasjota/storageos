import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { MrrSnapshotCron } from './mrr-snapshot.cron';
import { MrrSnapshotService } from './mrr-snapshot.service';

/**
 * Snapshots de MRR + MRR movements. Módulo ligero (sin controllers) para que lo
 * importen tanto `AdminModule` (el endpoint de métricas usa el service) como el
 * worker (el cron mensual). El cron solo se registra con
 * `ENABLE_WORKERS_IN_API=true`.
 */
@Module({
  providers: [MrrSnapshotService, ...(WORKERS_ENABLED_IN_API ? [MrrSnapshotCron] : [])],
  exports: [MrrSnapshotService],
})
export class MrrModule {}
