import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { EmailService } from './email.service';

export interface EmailSendJobData {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Worker BullMQ que envía un email ad-hoc encolado (broadcasts del super admin).
 * Reintentos + backoff los aporta la config por defecto de la cola; un fallo se
 * propaga para que BullMQ reintente.
 */
@Processor(QUEUE_EMAIL, { concurrency: 5 })
export class EmailSendProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailSendProcessor.name);

  constructor(private readonly email: EmailService) {
    super();
  }

  async process(job: Job<EmailSendJobData>): Promise<void> {
    if (job.name !== JOB_EMAIL_SEND) {
      this.logger.warn(`Job desconocido en ${QUEUE_EMAIL}: ${job.name}`);
      return;
    }
    const { to, subject, html, text } = job.data;
    await this.email.sendRendered({ to, subject, html, text });
  }
}
