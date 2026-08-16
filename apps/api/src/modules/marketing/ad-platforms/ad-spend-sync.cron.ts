import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AdSpendSyncService } from './ad-spend-sync.service';

/**
 * Cron diario: sincroniza el gasto de Google Ads / Meta Ads de todos los
 * canales con la integración activa. Hace llamadas HTTP salientes reales
 * por cada canal → gated por `WORKERS_ENABLED_IN_API` (corre solo en el
 * worker en producción, como el resto de crons "pesados").
 */
@Injectable()
export class AdSpendSyncCron {
  private readonly logger = new Logger(AdSpendSyncCron.name);

  constructor(private readonly sync: AdSpendSyncService) {}

  @Cron('0 8 * * *')
  async daily(): Promise<void> {
    try {
      await this.sync.syncDueAll();
    } catch (err) {
      this.logger.error(
        `Cron de sincronización de gasto publicitario falló: ${(err as Error).message}`,
      );
    }
  }
}
