import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_PAYMENTS_AUTO_CHARGE, QUEUE_PAYMENTS } from '../queues/queues.module';

import { AutoChargeService, type AutoChargeJobData } from './auto-charge.service';

/**
 * Worker BullMQ de la cola `payments` (auto-charge al emitir factura).
 * Patron `BillingRecurringProcessor`: el wrapper se registra solo cuando
 * `ENABLE_WORKERS_IN_API=true` (dev/test o `apps/worker`); la logica vive
 * en `AutoChargeService`, que el API registra siempre (su `@OnEvent`
 * encola desde el proceso HTTP).
 */
@Processor(QUEUE_PAYMENTS)
export class AutoChargeProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoChargeProcessor.name);

  constructor(private readonly autoCharge: AutoChargeService) {
    super();
  }

  async process(job: Job<AutoChargeJobData>): Promise<{ charged: boolean; reason?: string }> {
    if (job.name !== JOB_PAYMENTS_AUTO_CHARGE) {
      this.logger.warn(`Job desconocido en ${QUEUE_PAYMENTS}: ${job.name}`);
      return { charged: false, reason: 'unknown_job' };
    }
    return this.autoCharge.processAutoCharge(job.data);
  }
}
