import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Job } from 'bullmq';

import { JOB_BILLING_GENERATE_RECURRING, QUEUE_BILLING } from '../queues/queues.module';

import { BillingJobsService, type GenerateRecurringJobData } from './billing-jobs.service';

/**
 * Worker BullMQ + cron diario para la facturacion recurrente.
 *
 * Antes (Fase 4) los decoradores `@Processor` y `@Cron` vivian en
 * `BillingJobsService`. Sub-bloque 14A.1 los extrae aqui para poder
 * registrar SOLO este wrapper cuando `ENABLE_WORKERS_IN_API=true`
 * (dev/test o el proceso `apps/worker`) y mantener `BillingJobsService`
 * siempre disponible para que `InvoicesController.runRecurring` pueda
 * encolar jobs manuales en el API HTTP-only.
 *
 * La logica de negocio (encolado por tenant + procesamiento del job)
 * vive en `BillingJobsService`; aqui solo enrutamos.
 */
@Processor(QUEUE_BILLING)
export class BillingRecurringProcessor extends WorkerHost {
  private readonly logger = new Logger(BillingRecurringProcessor.name);

  constructor(private readonly jobs: BillingJobsService) {
    super();
  }

  /**
   * Cron diario a las 02:00 UTC. Encola un job por tenant activo. En
   * dev se puede disparar manualmente con `POST /billing/jobs/run-recurring`
   * (delega en `BillingJobsService.enqueueForTenant`).
   */
  @Cron('0 2 * * *', { name: 'billing.generate-recurring.daily' })
  async dailyEnqueue(): Promise<void> {
    await this.jobs.dailyEnqueueAll();
  }

  /** Handler del worker BullMQ. */
  async process(job: Job<GenerateRecurringJobData>): Promise<{ created: number }> {
    if (job.name !== JOB_BILLING_GENERATE_RECURRING) {
      this.logger.warn(`Job desconocido en ${QUEUE_BILLING}: ${job.name}`);
      return { created: 0 };
    }
    return this.jobs.processGenerateRecurring(job.data);
  }
}
