import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { StorageUsageService } from './storage-usage.service';

/** Medición diaria del almacenamiento por tenant (corre en el worker). */
@Injectable()
export class StorageUsageCron {
  private readonly logger = new Logger(StorageUsageCron.name);

  constructor(private readonly storage: StorageUsageService) {}

  @Cron('30 4 * * *', { name: 'storage-usage.daily' })
  async handle(): Promise<void> {
    try {
      const r = await this.storage.measure();
      this.logger.log(`[storage] medidos ${r.tenants} tenants (${r.bytes} bytes)`);
    } catch (err) {
      this.logger.error(`[storage] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
