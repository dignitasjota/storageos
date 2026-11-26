import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_SEO_CRAWL, QUEUE_SEO_CRAWL } from '../../queues/queue-names';

import { SeoCrawlerService } from './seo-crawler.service';

/**
 * Worker de los rastreos (PR 10): dos proyectos a la vez como mucho, cada uno
 * con una sola petición en marcha y su pausa entre peticiones (la pone el
 * servicio). Se registra solo con `ENABLE_WORKERS_IN_API` (dev/test o el worker).
 */
@Processor(QUEUE_SEO_CRAWL, { concurrency: 2 })
export class SeoCrawlProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoCrawlProcessor.name);

  constructor(private readonly crawler: SeoCrawlerService) {
    super();
  }

  async process(job: Job<{ crawlId: string }>): Promise<void> {
    if (job.name !== JOB_SEO_CRAWL || !job.data.crawlId) {
      this.logger.warn(`Job desconocido en ${QUEUE_SEO_CRAWL}: ${job.name}`);
      return;
    }
    await this.crawler.process(job.data.crawlId);
  }
}
