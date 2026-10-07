import { Module } from '@nestjs/common';

import { WORKERS_ENABLED_IN_API } from '../../config/workers-enabled';

import { StorageUsageCron } from './storage-usage.cron';
import { StorageUsageService } from './storage-usage.service';

/**
 * Medición del almacenamiento por tenant. Módulo ligero para que lo importen
 * `AdminModule` (botón «Medir ahora») y el worker (cron diario).
 */
@Module({
  providers: [StorageUsageService, ...(WORKERS_ENABLED_IN_API ? [StorageUsageCron] : [])],
  exports: [StorageUsageService],
})
export class UsageModule {}
