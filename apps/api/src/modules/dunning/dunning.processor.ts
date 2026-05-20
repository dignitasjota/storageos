import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Job } from 'bullmq';

import { QUEUE_DUNNING } from '../queues/queues.module';

import {
  DunningService,
  type ExecuteActionJobData,
  type ProcessInvoiceJobData,
} from './dunning.service';

/**
 * Wrapper que aloja el `@Processor` BullMQ y el `@Cron` diario del modulo
 * de dunning. Toda la logica vive en `DunningService`; este wrapper solo
 * enruta los disparos.
 *
 * Sub-bloque 14A.1: se registra (junto con `DunningService`) solo cuando
 * `ENABLE_WORKERS_IN_API=true`. En produccion el API no lo monta y el
 * proceso `apps/worker` se encarga del cron + procesado.
 */
@Processor(QUEUE_DUNNING)
export class DunningProcessor extends WorkerHost {
  constructor(private readonly dunning: DunningService) {
    super();
  }

  /** Cron diario 06:00 UTC. */
  @Cron('0 6 * * *', { name: 'dunning.daily' })
  async dailyTick(): Promise<void> {
    await this.dunning.dailyTick();
  }

  async process(job: Job<ProcessInvoiceJobData | ExecuteActionJobData>): Promise<{ ok: boolean }> {
    return this.dunning.handleJob(job.name, job.data);
  }
}
