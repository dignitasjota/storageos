import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_REPORTS_GENERATE, QUEUE_REPORTS } from '../queues/queues.module';

import { ReportsService, type ReportJobData } from './reports.service';

@Processor(QUEUE_REPORTS, { concurrency: 2 })
export class ReportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportsProcessor.name);

  constructor(private readonly service: ReportsService) {
    super();
  }

  async process(job: Job<ReportJobData>): Promise<void> {
    if (job.name !== JOB_REPORTS_GENERATE) {
      this.logger.warn(`Job desconocido: ${job.name}`);
      return;
    }
    await this.service.generate(job.data);
  }
}
