import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_SEO_SISTRIX_SYNC, QUEUE_SEO_SISTRIX } from '../../queues/queue-names';

import { SistrixSyncService } from './sistrix-sync.service';

/**
 * Worker de las tandas de SISTRIX: de una en una (concurrencia 1) para no
 * pasar del ritmo que admite SISTRIX; la pausa entre llamadas la pone el
 * servicio. Se registra solo con `ENABLE_WORKERS_IN_API` (dev/test o el worker).
 */
@Processor(QUEUE_SEO_SISTRIX, { concurrency: 1 })
export class SistrixProcessor extends WorkerHost {
  private readonly logger = new Logger(SistrixProcessor.name);

  constructor(private readonly sync: SistrixSyncService) {
    super();
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    if (job.name !== JOB_SEO_SISTRIX_SYNC) {
      this.logger.warn(`Job desconocido en ${QUEUE_SEO_SISTRIX}: ${job.name}`);
      return;
    }
    await this.sync.processRun(job.data.runId);
  }
}
