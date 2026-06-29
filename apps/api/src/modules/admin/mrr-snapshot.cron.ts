import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { MrrSnapshotService } from './mrr-snapshot.service';

/**
 * Captura el snapshot de MRR del mes en curso a primeros de cada mes, para que
 * los MRR movements tengan una foto por mes aunque nadie abra el panel. La
 * captura es idempotente (upsert por tenant+mes); el endpoint también la
 * asegura on-demand.
 *
 * Solo se registra con `ENABLE_WORKERS_IN_API=true` (corre en el worker en
 * producción).
 */
@Injectable()
export class MrrSnapshotCron {
  private readonly logger = new Logger(MrrSnapshotCron.name);

  constructor(private readonly snapshots: MrrSnapshotService) {}

  @Cron('0 3 1 * *', { name: 'mrr.monthly-snapshot' })
  async run(): Promise<void> {
    await this.snapshots.captureMonth(new Date());
    this.logger.log('Snapshot mensual de MRR capturado');
  }
}
