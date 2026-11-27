import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_SEO_PAGESPEED, QUEUE_SEO_PAGESPEED } from '../../queues/queue-names';

import { SeoPageSpeedService } from './seo-pagespeed.service';

/**
 * Worker de la cola `seo-pagespeed`: las mediciones de PageSpeed, de una en una
 * (una medición puede tardar minutos si Google va lento, y en la cola `seo`
 * retrasaba las descargas de Search Console de todos los negocios).
 */
@Processor(QUEUE_SEO_PAGESPEED, { concurrency: 1 })
export class SeoPageSpeedProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoPageSpeedProcessor.name);

  constructor(private readonly pagespeed: SeoPageSpeedService) {
    super();
  }

  async process(job: Job<{ projectId?: string }>): Promise<void> {
    if (job.name !== JOB_SEO_PAGESPEED || !job.data.projectId) {
      this.logger.warn(`Job desconocido en ${QUEUE_SEO_PAGESPEED}: ${job.name}`);
      return;
    }
    await this.pagespeed.processQueue(job.data.projectId);
  }
}
