import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { DahuaSyncService } from './dahua-sync.service';

/**
 * Reconciliación periódica de los registros de acceso de los terminales Patrón B
 * (offline) → `access_logs`. Solo se registra con `ENABLE_WORKERS_IN_API=true`
 * (corre en el worker en producción).
 */
@Injectable()
export class DahuaReconcileCron {
  private readonly logger = new Logger(DahuaReconcileCron.name);

  constructor(private readonly sync: DahuaSyncService) {}

  @Cron('*/10 * * * *', { name: 'access.dahua-reconcile' })
  async run(): Promise<{ devices: number; imported: number }> {
    const result = await this.sync.reconcileAllDue();
    if (result.imported > 0) {
      this.logger.log(
        `[sync] reconciliados ${result.imported} accesos de ${result.devices} terminales`,
      );
    }
    return result;
  }
}
