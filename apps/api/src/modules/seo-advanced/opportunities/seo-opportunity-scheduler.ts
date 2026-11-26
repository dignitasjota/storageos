import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { JOB_SEO_OPPORTUNITIES, QUEUE_SEO } from '../../queues/queue-names';

/** Espera antes de recalcular tras una descarga (junta varias seguidas). */
const RECALC_DELAY_MS = 60_000;

/**
 * Programa un recálculo de las oportunidades de un proyecto en la cola `seo`
 * (lo usan las descargas de Search Console y las tandas de SISTRIX al
 * terminar). Un solo trabajo pendiente por proyecto; nunca falla hacia fuera.
 */
@Injectable()
export class SeoOpportunityScheduler {
  private readonly logger = new Logger(SeoOpportunityScheduler.name);

  constructor(@InjectQueue(QUEUE_SEO) private readonly queue: Queue) {}

  async schedule(projectId: string): Promise<void> {
    try {
      await this.queue.add(
        JOB_SEO_OPPORTUNITIES,
        { projectId },
        {
          jobId: `seo-opp-${projectId}`,
          delay: process.env.NODE_ENV === 'test' ? 0 : RECALC_DELAY_MS,
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 1,
        },
      );
    } catch (err) {
      this.logger.warn(
        `No se pudo programar el cálculo de oportunidades: ${(err as Error).message}`,
      );
    }
  }
}
