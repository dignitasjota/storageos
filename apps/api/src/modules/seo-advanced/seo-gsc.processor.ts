import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_SEO_GSC_SYNC, JOB_SEO_OPPORTUNITIES, QUEUE_SEO } from '../queues/queue-names';

import { SeoOpportunityEngineService } from './opportunities/seo-opportunity-engine.service';
import { SeoGscSyncService } from './seo-gsc-sync.service';

/**
 * Worker de la cola `seo`: descargas de Search Console de SEO Avanzado y
 * recálculo de las oportunidades. Se registra solo con `ENABLE_WORKERS_IN_API`
 * (dev/test o `apps/worker`); la lógica vive en `SeoGscSyncService` y en
 * `SeoOpportunityEngineService`.
 */
@Processor(QUEUE_SEO, { concurrency: 2 })
export class SeoGscProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoGscProcessor.name);

  constructor(
    private readonly sync: SeoGscSyncService,
    private readonly opportunities: SeoOpportunityEngineService,
  ) {
    super();
  }

  async process(job: Job<{ runId?: string; projectId?: string }>): Promise<void> {
    if (job.name === JOB_SEO_OPPORTUNITIES && job.data.projectId) {
      await this.opportunities.recalculate(job.data.projectId);
      return;
    }
    if (job.name !== JOB_SEO_GSC_SYNC || !job.data.runId) {
      this.logger.warn(`Job desconocido en ${QUEUE_SEO}: ${job.name}`);
      return;
    }
    await this.sync.processRun(job.data.runId);
  }
}
