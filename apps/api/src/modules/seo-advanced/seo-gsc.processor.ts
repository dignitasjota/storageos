import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_SEO_GSC_SYNC, QUEUE_SEO } from '../queues/queue-names';

import { SeoGscSyncService } from './seo-gsc-sync.service';

/**
 * Worker de la cola `seo` (descargas de Search Console de SEO Avanzado). Se
 * registra solo con `ENABLE_WORKERS_IN_API` (dev/test o `apps/worker`); la
 * lógica vive en `SeoGscSyncService`.
 */
@Processor(QUEUE_SEO, { concurrency: 2 })
export class SeoGscProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoGscProcessor.name);

  constructor(private readonly sync: SeoGscSyncService) {
    super();
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    if (job.name !== JOB_SEO_GSC_SYNC) {
      this.logger.warn(`Job desconocido en ${QUEUE_SEO}: ${job.name}`);
      return;
    }
    await this.sync.processRun(job.data.runId);
  }
}
