import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import {
  TenantDataExportJobsService,
  type TenantDataExportJobData,
} from '../admin/tenant-data-export-jobs.service';
import { JOB_TENANT_DATA_EXPORT } from '../queues/queue-names';
import { JOB_REPORTS_GENERATE, QUEUE_REPORTS } from '../queues/queues.module';

import { ReportsService, type ReportJobData } from './reports.service';

@Processor(QUEUE_REPORTS, { concurrency: 2 })
export class ReportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportsProcessor.name);

  constructor(
    private readonly service: ReportsService,
    private readonly tenantExports: TenantDataExportJobsService,
  ) {
    super();
  }

  async process(job: Job<ReportJobData | TenantDataExportJobData>): Promise<void> {
    // Exportación de un tenant pedida por el super admin.
    if (job.name === JOB_TENANT_DATA_EXPORT) {
      await this.tenantExports.process((job.data as TenantDataExportJobData).exportId);
      return;
    }
    if (job.name !== JOB_REPORTS_GENERATE) {
      this.logger.warn(`Job desconocido: ${job.name}`);
      return;
    }
    await this.service.generate(job.data as ReportJobData);
  }
}
