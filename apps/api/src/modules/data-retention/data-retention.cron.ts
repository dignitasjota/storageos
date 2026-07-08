import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { DataRetentionService } from './data-retention.service';

/**
 * Cron diario (04:00 UTC) de retención de datos. Aislado en su propia clase para
 * mantener `DataRetentionService` sin dependencia de `@nestjs/schedule` y poder
 * gatearlo con `WORKERS_ENABLED_IN_API` (corre en el worker en producción).
 */
@Injectable()
export class DataRetentionCron {
  private readonly logger = new Logger(DataRetentionCron.name);

  constructor(private readonly service: DataRetentionService) {}

  @Cron('0 4 * * *', { name: 'data-retention.cleanup' })
  async dailyCleanup(): Promise<void> {
    try {
      await this.service.runCleanup();
    } catch (err) {
      this.logger.error(
        `data-retention cleanup falló: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
