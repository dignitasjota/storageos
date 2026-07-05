import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { MrrSnapshotService } from './mrr-snapshot.service';

/**
 * Captura el snapshot de MRR del mes en curso + reconstruye desde pagos, para
 * que los MRR movements tengan la foto por mes SIN escribir en el path de
 * lectura (el endpoint solo asegura la existencia del mes en curso, no reescribe
 * ~500 filas en cada GET). Diario (antes mensual) para reflejar cambios de plan
 * intramensuales; ambas operaciones son idempotentes (upsert / createMany
 * skipDuplicates).
 *
 * Solo se registra con `ENABLE_WORKERS_IN_API=true` (corre en el worker en
 * producción).
 */
@Injectable()
export class MrrSnapshotCron {
  private readonly logger = new Logger(MrrSnapshotCron.name);

  constructor(private readonly snapshots: MrrSnapshotService) {}

  @Cron('0 3 * * *', { name: 'mrr.daily-snapshot' })
  async run(): Promise<void> {
    await this.snapshots.captureMonth(new Date());
    await this.snapshots.backfillFromPayments(13);
    this.logger.log('Snapshot diario de MRR capturado');
  }
}
