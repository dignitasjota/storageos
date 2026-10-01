import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { EmailService } from './email.service';

import type { PlatformEmailKind, PlatformSenderCategory } from '@storageos/shared';

export interface EmailSendJobData {
  to: string;
  /** Tipo de correo de la plataforma → su remitente (panel admin → Correo saliente). */
  category?: PlatformSenderCategory;
  /** Correo concreto → tipo de remitente y texto de `{tipo}` del nombre. */
  kind?: PlatformEmailKind;
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
    const { to, category, kind, subject, html, text } = job.data;
    await this.email.sendRendered({
      to,
      ...(category ? { category } : {}),
      ...(kind ? { kind } : {}),
      subject,
      html,
      text,
    });
  }
}
