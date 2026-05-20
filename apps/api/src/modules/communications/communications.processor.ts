import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_COMMUNICATIONS_DISPATCH, QUEUE_COMMUNICATIONS } from '../queues/queues.module';

import { CommunicationsService, type DispatchJobData } from './communications.service';

/**
 * Worker BullMQ que despacha communications encoladas. La logica vive en
 * CommunicationsService.dispatch; aqui solo enrutamos por nombre de job.
 */
@Processor(QUEUE_COMMUNICATIONS, { concurrency: 5 })
export class CommunicationsProcessor extends WorkerHost {
  private readonly logger = new Logger(CommunicationsProcessor.name);

  constructor(private readonly service: CommunicationsService) {
    super();
  }

  async process(job: Job<DispatchJobData>): Promise<void> {
    if (job.name !== JOB_COMMUNICATIONS_DISPATCH) {
      this.logger.warn(`Job desconocido en ${QUEUE_COMMUNICATIONS}: ${job.name}`);
      return;
    }
    const { tenantId, communicationId } = job.data;
    await this.service.dispatch(tenantId, communicationId);
  }
}
