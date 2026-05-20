import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_AUTOMATIONS_RUN, QUEUE_AUTOMATIONS } from '../queues/queues.module';

import { AutomationsService, type AutomationJobData } from './automations.service';

@Processor(QUEUE_AUTOMATIONS, { concurrency: 5 })
export class AutomationsProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationsProcessor.name);

  constructor(private readonly service: AutomationsService) {
    super();
  }

  async process(job: Job<AutomationJobData>): Promise<void> {
    if (job.name !== JOB_AUTOMATIONS_RUN) {
      this.logger.warn(`Job desconocido: ${job.name}`);
      return;
    }
    await this.service.runJob(job.data);
  }
}
